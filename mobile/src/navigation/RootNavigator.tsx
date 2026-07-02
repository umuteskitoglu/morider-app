import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme, LinkingOptions, NavigatorScreenParams, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator, BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useAuth } from '../store/auth';
import { useChatUnread } from '../store/chatUnread';
import { registerForPush } from '../lib/push';
import OnboardingTour from '../components/OnboardingTour';
import { registerTourNode } from '../components/TourTarget';
import { navigationRef } from './navigationRef';
import { colors, gradients, radius, shadow, spacing } from '../theme';
import LoginScreen from '../screens/LoginScreen';
import SignupScreen from '../screens/SignupScreen';
import MapScreen from '../screens/MapScreen';
import RidesScreen from '../screens/RidesScreen';
import RideDetailScreen from '../screens/RideDetailScreen';
import RoutesScreen from '../screens/RoutesScreen';
import ExploreScreen from '../screens/ExploreScreen';
import RouteCreateScreen from '../screens/RouteCreateScreen';
import RouteDetailScreen from '../screens/RouteDetailScreen';
import GroupJoinScreen from '../screens/GroupJoinScreen';
import GroupRideScreen from '../screens/GroupRideScreen';
import FeedScreen from '../screens/FeedScreen';
import CreatePostScreen from '../screens/CreatePostScreen';
import LocationPickerScreen from '../screens/LocationPickerScreen';
import UserProfileScreen from '../screens/UserProfileScreen';
import UserSearchScreen from '../screens/UserSearchScreen';
import CommentsScreen from '../screens/CommentsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import FollowsScreen from '../screens/FollowsScreen';
import GarageScreen from '../screens/GarageScreen';
import BikeDetailScreen from '../screens/BikeDetailScreen';
import SegmentsScreen from '../screens/SegmentsScreen';
import SegmentDetailScreen from '../screens/SegmentDetailScreen';
import ChallengesScreen from '../screens/ChallengesScreen';
import ChallengeDetailScreen from '../screens/ChallengeDetailScreen';
import EventsScreen from '../screens/EventsScreen';
import EventCreateScreen from '../screens/EventCreateScreen';
import EventDetailScreen from '../screens/EventDetailScreen';
import EventChatScreen from '../screens/EventChatScreen';
import EventLocationPickerScreen from '../screens/EventLocationPickerScreen';
import ConversationsScreen from '../screens/ConversationsScreen';
import GlobalChatScreen from '../screens/GlobalChatScreen';
import ChatThreadScreen from '../screens/ChatThreadScreen';

export type AuthStackParams = {
  Login: undefined;
  Signup: undefined;
};

// Group riding lives under the Ride tab — it is a way to ride, not a route list.
export type RideStackParams = {
  // followReverse: ride the saved route end→start (B→A). Omitted = smart
  // default (MapScreen flips automatically when the rider stands near the end).
  RideMain: { followRouteId?: number; followReverse?: boolean } | undefined;
  // `code` arrives via deep link (morider://join/<code>) and auto-joins.
  GroupJoin: { code?: string } | undefined;
  GroupRide: { code: string };
};

export type FeedStackParams = {
  FeedList: undefined;
  CreatePost: { pickedLat?: number; pickedLon?: number; pickedName?: string } | undefined;
  LocationPicker: undefined;
  UserProfile: { userId: number; name: string };
  UserSearch: undefined;
  Comments: { postId: number };
  // Without params: the caller's own follows. With userId: that user's lists
  // (subject to the connection-based visibility rule), opened on `tab`.
  Follows: { userId?: number; name?: string; tab?: 'following' | 'followers' } | undefined;
};

// "You" hub: account plus everything that belongs to the rider — ride history,
// saved routes and follows all live here so the tab bar stays short.
export type ProfileStackParams = {
  ProfileMain: undefined;
  EditProfile: undefined;
  // Without params: the caller's own follows. With userId: that user's lists
  // (subject to the connection-based visibility rule), opened on `tab`.
  Follows: { userId?: number; name?: string; tab?: 'following' | 'followers' } | undefined;
  UserProfile: { userId: number; name: string };
  Rides: undefined;
  RideDetail: { id: number };
  RoutesList: undefined;
  Explore: undefined;
  RouteCreate: undefined;
  RouteDetail: { id: number; name: string };
  Garage: undefined;
  BikeDetail: { id: number; name: string };
  Segments: undefined;
  SegmentDetail: { id: number; name: string };
  Challenges: undefined;
  ChallengeDetail: { id: number; name: string };
};

export type EventsStackParams = {
  EventsList: undefined;
  // With `code` the form edits that event; without it, it creates a new one.
  EventCreate: { code?: string } | undefined;
  EventDetail: { code: string };
  EventChat: { code: string; title?: string };
  // Picked location is delivered via the eventDraft store, not params, so both
  // start and end survive the create screen remounting during the round-trip.
  EventLocationPicker: { target: 'start' | 'end' };
};

// Community + private messaging. Global is the single community room; the DM
// inbox and per-conversation threads handle one-to-one chat. ChatThread accepts
// either a conversationId (from the inbox / deep link) or a userId (from a rider
// tapped on the map, which is resolved into a conversation on open).
export type ChatStackParams = {
  Conversations: undefined;
  GlobalChat: undefined;
  ChatThread: { conversationId?: number; userId?: number; name?: string; avatarUrl?: string };
};

export type AppTabParams = {
  Ride: NavigatorScreenParams<RideStackParams> | undefined;
  Feed: undefined;
  Events: NavigatorScreenParams<EventsStackParams> | undefined;
  Chat: NavigatorScreenParams<ChatStackParams> | undefined;
  Profile: NavigatorScreenParams<ProfileStackParams> | undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const RideStack = createNativeStackNavigator<RideStackParams>();
const FeedStack = createNativeStackNavigator<FeedStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();
const EventsStack = createNativeStackNavigator<EventsStackParams>();
const ChatStack = createNativeStackNavigator<ChatStackParams>();
const Tabs = createBottomTabNavigator<AppTabParams>();

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// Consistent, evenly-spaced header action button (does not rely on flex `gap`).
function HeaderIconButton({ icon, onPress }: { icon: IconName; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.headerBtn}>
      <MaterialCommunityIcons name={icon} size={22} color={colors.primary} />
    </Pressable>
  );
}

// The Ride tab: solo ride map plus the group-ride flow, so "ride together" is
// reachable right where you start a ride.
function RideNavigator() {
  return (
    <RideStack.Navigator
      // headerShown stays off for every screen in this stack: mixing native
      // headers on/off within one native-stack (as this used to do) leaves a
      // ghost header view behind on Android when popping back to RideMain,
      // which then bleeds through every tab until the app restarts. GroupJoin
      // and GroupRide carry their own in-screen title/back and exit controls.
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <RideStack.Screen name="RideMain" component={MapScreen} />
      <RideStack.Screen name="GroupJoin" component={GroupJoinScreen} />
      <RideStack.Screen name="GroupRide" component={GroupRideScreen} />
    </RideStack.Navigator>
  );
}

function ProfileNavigator() {
  return (
    <ProfileStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <ProfileStack.Screen name="ProfileMain" component={ProfileScreen} options={{ title: 'Profil' }} />
      <ProfileStack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'Profili Düzenle' }} />
      <ProfileStack.Screen name="Rides" component={RidesScreen} options={{ title: 'Sürüşlerim' }} />
      <ProfileStack.Screen name="RideDetail" component={RideDetailScreen} options={{ title: 'Sürüş Detayı' }} />
      <ProfileStack.Screen
        name="RoutesList"
        component={RoutesScreen}
        options={({ navigation }) => ({
          title: 'Rotalarım',
          headerRight: () => (
            <View style={styles.headerRow}>
              <HeaderIconButton icon="flag-checkered" onPress={() => navigation.navigate('Segments')} />
              <HeaderIconButton icon="compass-outline" onPress={() => navigation.navigate('Explore')} />
            </View>
          ),
        })}
      />
      <ProfileStack.Screen name="Explore" component={ExploreScreen} options={{ title: 'Keşfet' }} />
      <ProfileStack.Screen name="RouteCreate" component={RouteCreateScreen} options={{ title: 'Yeni Rota' }} />
      <ProfileStack.Screen name="RouteDetail" component={RouteDetailScreen} options={{ title: 'Rota' }} />
      <ProfileStack.Screen name="Follows" component={FollowsScreen} options={{ title: 'Takip' }} />
      <ProfileStack.Screen name="UserProfile" component={UserProfileScreen} options={{ title: 'Profil' }} />
      <ProfileStack.Screen name="Garage" component={GarageScreen} options={{ title: 'Garajım' }} />
      <ProfileStack.Screen name="BikeDetail" component={BikeDetailScreen} options={{ title: 'Motor' }} />
      <ProfileStack.Screen name="Segments" component={SegmentsScreen} options={{ title: 'Kapışmalar' }} />
      <ProfileStack.Screen name="SegmentDetail" component={SegmentDetailScreen} options={{ title: 'Kapışma' }} />
      <ProfileStack.Screen name="Challenges" component={ChallengesScreen} options={{ title: 'Meydan Okumalar' }} />
      <ProfileStack.Screen name="ChallengeDetail" component={ChallengeDetailScreen} options={{ title: 'Meydan Okuma' }} />
    </ProfileStack.Navigator>
  );
}

function EventsNavigator() {
  return (
    <EventsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <EventsStack.Screen name="EventsList" component={EventsScreen} options={{ title: 'Etkinlikler' }} />
      <EventsStack.Screen name="EventCreate" component={EventCreateScreen} options={{ title: 'Yeni Etkinlik' }} />
      <EventsStack.Screen name="EventDetail" component={EventDetailScreen} options={{ title: 'Etkinlik' }} />
      <EventsStack.Screen name="EventChat" component={EventChatScreen} options={{ title: 'Sohbet' }} />
      <EventsStack.Screen name="EventLocationPicker" component={EventLocationPickerScreen} options={{ title: 'Konum Seç' }} />
    </EventsStack.Navigator>
  );
}

function ChatNavigator() {
  return (
    <ChatStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <ChatStack.Screen name="Conversations" component={ConversationsScreen} options={{ title: 'Mesajlar' }} />
      <ChatStack.Screen name="GlobalChat" component={GlobalChatScreen} options={{ title: 'Topluluk Sohbeti' }} />
      <ChatStack.Screen name="ChatThread" component={ChatThreadScreen} options={{ title: 'Sohbet' }} />
    </ChatStack.Navigator>
  );
}

function FeedNavigator() {
  return (
    <FeedStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <FeedStack.Screen name="FeedList" component={FeedScreen} options={{ headerShown: false }} />
      <FeedStack.Screen name="CreatePost" component={CreatePostScreen} options={{ title: 'Yeni Paylaşım' }} />
      <FeedStack.Screen name="LocationPicker" component={LocationPickerScreen} options={{ title: 'Konum Seç' }} />
      <FeedStack.Screen name="UserProfile" component={UserProfileScreen} options={{ title: 'Profil' }} />
      <FeedStack.Screen name="UserSearch" component={UserSearchScreen} options={{ title: 'Kişi Bul' }} />
      <FeedStack.Screen name="Follows" component={FollowsScreen} options={{ title: 'Takip' }} />
      <FeedStack.Screen name="Comments" component={CommentsScreen} options={{ title: 'Yorumlar' }} />
    </FeedStack.Navigator>
  );
}

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.primary,
  },
};

// Deep links: morider://event/<code> opens the event directly in the Events tab,
// morider://join/<code> lands on the group-join screen and auto-joins.
// The Expo `scheme` ("morider") is declared in app.json.
const linking: LinkingOptions<AppTabParams> = {
  prefixes: ['morider://'],
  config: {
    screens: {
      Events: {
        screens: {
          EventDetail: 'event/:code',
        },
      },
      Ride: {
        screens: {
          GroupJoin: 'join/:code',
        },
      },
      // morider://dm/<conversationId> opens a direct-message thread (used by DM
      // push notifications).
      Chat: {
        screens: {
          ChatThread: 'dm/:conversationId',
        },
      },
    },
  },
};

// Per-tab presentation for the custom bar. Keeping it here keeps AppTabs lean.
const TAB_META: Record<keyof AppTabParams, { icon: IconName; label: string }> = {
  Ride: { icon: 'motorbike', label: 'Sürüş' },
  Feed: { icon: 'image-multiple', label: 'Akış' },
  Events: { icon: 'calendar-clock', label: 'Etkinlik' },
  Chat: { icon: 'chat', label: 'Sohbet' },
  Profile: { icon: 'account', label: 'Profil' },
};

// A single tab cell. The active cell lifts its icon and fades in an ember glow
// + label, giving the bar a lively, premium feel without extra dependencies.
function TabCell({
  focused,
  icon,
  label,
  badge,
  onPress,
  tourId,
}: {
  focused: boolean;
  icon: IconName;
  label: string;
  badge?: number;
  onPress: () => void;
  // Registers the cell as an onboarding-tour spotlight target.
  tourId: string;
}) {
  const anim = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: focused ? 1 : 0, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
  }, [focused, anim]);

  const lift = anim.interpolate({ inputRange: [0, 1], outputRange: [0, -3] });
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Pressable ref={(node) => registerTourNode(tourId, node)} style={styles.tabCell} onPress={onPress} hitSlop={6}>
      <Animated.View style={[styles.tabIconWrap, focused && styles.tabIconWrapOn, { transform: [{ translateY: lift }, { scale }] }]}>
        {focused && <Animated.View style={[styles.tabGlow, { opacity: anim }]} />}
        <MaterialCommunityIcons name={icon} size={24} color={focused ? colors.primary : colors.textMuted} />
        {!!badge && (
          <View style={styles.tabBadge}>
            <Text style={styles.tabBadgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Animated.View>
      <Text style={[styles.tabLabel, focused && styles.tabLabelOn]}>{label}</Text>
    </Pressable>
  );
}

function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { unreadCount } = useChatUnread();

  // Hide on immersive screens that opt out (e.g. the live group-ride map).
  const focused = state.routes[state.index];
  const nested = getFocusedRouteNameFromRoute(focused);
  if (nested === 'GroupRide') return null;

  return (
    <View style={[styles.tabBarWrap, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]} pointerEvents="box-none">
      <LinearGradient colors={gradients.glass} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.tabBar}>
        {state.routes.map((route, index) => {
          const meta = TAB_META[route.name as keyof AppTabParams];
          const isFocused = state.index === index;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <TabCell
              key={route.key}
              focused={isFocused}
              icon={meta.icon}
              label={meta.label}
              badge={route.name === 'Chat' ? unreadCount : undefined}
              onPress={onPress}
              tourId={`tab.${route.name}`}
            />
          );
        })}
      </LinearGradient>
    </View>
  );
}

function AppTabs() {
  return (
    <Tabs.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface, shadowColor: 'transparent', elevation: 0 },
        headerTitleStyle: { color: colors.text, fontWeight: '800', letterSpacing: 0.5 },
        headerTintColor: colors.primary,
      }}
    >
      <Tabs.Screen name="Ride" component={RideNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Feed" component={FeedNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Events" component={EventsNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Chat" component={ChatNavigator} options={{ headerShown: false }} />
      <Tabs.Screen name="Profile" component={ProfileNavigator} options={{ headerShown: false }} />
    </Tabs.Navigator>
  );
}

function AuthFlow() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
    </AuthStack.Navigator>
  );
}

export default function RootNavigator() {
  const { token, loading } = useAuth();

  // Register this device for push once the rider is signed in (best effort).
  useEffect(() => {
    if (token) registerForPush();
  }, [token]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} linking={linking}>
      {token ? (
        <>
          <AppTabs />
          {/* First-run spotlight tutorial; self-hides once the rider has seen it. */}
          <OnboardingTour />
        </>
      ) : (
        <AuthFlow />
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  tabBarWrap: { backgroundColor: colors.bg, paddingTop: spacing.sm, paddingHorizontal: spacing.md },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    ...shadow.card,
  },
  tabCell: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 2 },
  tabIconWrap: { width: 44, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  tabIconWrapOn: { backgroundColor: 'rgba(255,106,26,0.12)' },
  tabGlow: {
    position: 'absolute',
    width: 44,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,106,26,0.18)',
  },
  tabBadge: {
    position: 'absolute',
    top: -2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  tabBadgeText: { color: '#fff', fontWeight: '900', fontSize: 9 },
  tabLabel: { fontSize: 10.5, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.2 },
  tabLabelOn: { color: colors.primary, fontWeight: '900' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xs },
  headerBtn: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, alignItems: 'center', justifyContent: 'center' },
  headerGroupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    marginRight: spacing.sm,
  },
  headerGroupText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
