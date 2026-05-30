import React from 'react';
import { ActivityIndicator, Pressable, Text, View, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme, NavigatorScreenParams, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useAuth } from '../store/auth';
import { colors, spacing } from '../theme';
import LoginScreen from '../screens/LoginScreen';
import SignupScreen from '../screens/SignupScreen';
import MapScreen from '../screens/MapScreen';
import RidesScreen from '../screens/RidesScreen';
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
import CommentsScreen from '../screens/CommentsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import FollowsScreen from '../screens/FollowsScreen';

export type AuthStackParams = {
  Login: undefined;
  Signup: undefined;
};

export type RoutesStackParams = {
  RoutesList: undefined;
  Explore: undefined;
  RouteCreate: undefined;
  RouteDetail: { id: number; name: string };
};

// Group riding lives under the Ride tab — it is a way to ride, not a route list.
export type RideStackParams = {
  RideMain: { followRouteId?: number } | undefined;
  GroupJoin: undefined;
  GroupRide: { code: string };
};

export type FeedStackParams = {
  FeedList: undefined;
  CreatePost: { pickedLat?: number; pickedLon?: number; pickedName?: string } | undefined;
  LocationPicker: undefined;
  UserProfile: { userId: number; name: string };
  Comments: { postId: number };
};

export type ProfileStackParams = {
  ProfileMain: undefined;
  Follows: undefined;
};

export type AppTabParams = {
  Ride: NavigatorScreenParams<RideStackParams> | undefined;
  Feed: undefined;
  Rides: undefined;
  Routes: undefined;
  Profile: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const RideStack = createNativeStackNavigator<RideStackParams>();
const RoutesStack = createNativeStackNavigator<RoutesStackParams>();
const FeedStack = createNativeStackNavigator<FeedStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();
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
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text, fontWeight: '800' },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <RideStack.Screen
        name="RideMain"
        component={MapScreen}
        options={({ navigation }) => ({
          title: 'Sürüş',
          headerRight: () => (
            <Pressable onPress={() => navigation.navigate('GroupJoin')} hitSlop={8} style={styles.headerGroupBtn}>
              <MaterialCommunityIcons name="account-group" size={16} color="#fff" />
              <Text style={styles.headerGroupText}>Grup</Text>
            </Pressable>
          ),
        })}
      />
      <RideStack.Screen name="GroupJoin" component={GroupJoinScreen} options={{ title: 'Grup Sürüşü' }} />
      <RideStack.Screen name="GroupRide" component={GroupRideScreen} options={{ title: 'Grup Sürüşü' }} />
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
      <ProfileStack.Screen
        name="ProfileMain"
        component={ProfileScreen}
        options={({ navigation }) => ({
          title: 'Profil',
          headerRight: () => (
            <View style={styles.headerRow}>
              <HeaderIconButton icon="account-multiple" onPress={() => navigation.navigate('Follows')} />
            </View>
          ),
        })}
      />
      <ProfileStack.Screen name="Follows" component={FollowsScreen} options={{ title: 'Takip' }} />
    </ProfileStack.Navigator>
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
      <FeedStack.Screen name="Comments" component={CommentsScreen} options={{ title: 'Yorumlar' }} />
    </FeedStack.Navigator>
  );
}

function RoutesNavigator() {
  return (
    <RoutesStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text },
        headerTintColor: colors.primary,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <RoutesStack.Screen
        name="RoutesList"
        component={RoutesScreen}
        options={({ navigation }) => ({
          title: 'Rotalarım',
          headerRight: () => (
            <View style={styles.headerRow}>
              <HeaderIconButton icon="compass-outline" onPress={() => navigation.navigate('Explore')} />
            </View>
          ),
        })}
      />
      <RoutesStack.Screen name="Explore" component={ExploreScreen} options={{ title: 'Keşfet' }} />
      <RoutesStack.Screen name="RouteCreate" component={RouteCreateScreen} options={{ title: 'Yeni Rota' }} />
      <RoutesStack.Screen name="RouteDetail" component={RouteDetailScreen} options={{ title: 'Rota' }} />
    </RoutesStack.Navigator>
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

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <MaterialCommunityIcons name={name} color={color} size={size} />
  );
}

function AppTabs() {
  const insets = useSafeAreaInsets();
  const tabBarStyle = {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    height: 58 + insets.bottom,
    paddingTop: 8,
    paddingBottom: Math.max(insets.bottom, 8),
  };
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface, shadowColor: 'transparent', elevation: 0 },
        headerTitleStyle: { color: colors.text, fontWeight: '800', letterSpacing: 0.5 },
        headerTintColor: colors.primary,
        tabBarStyle,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="Ride"
        component={RideNavigator}
        options={({ route }) => ({
          title: 'Sürüş',
          headerShown: false,
          tabBarIcon: tabIcon('motorbike'),
          // Hide the tab bar on the immersive live group-ride map.
          tabBarStyle: getFocusedRouteNameFromRoute(route) === 'GroupRide' ? { display: 'none' } : tabBarStyle,
        })}
      />
      <Tabs.Screen
        name="Feed"
        component={FeedNavigator}
        options={{ title: 'Akış', headerShown: false, tabBarIcon: tabIcon('image-multiple') }}
      />
      <Tabs.Screen
        name="Rides"
        component={RidesScreen}
        options={{ title: 'Sürüşlerim', tabBarLabel: 'Geçmiş', tabBarIcon: tabIcon('history') }}
      />
      <Tabs.Screen
        name="Routes"
        component={RoutesNavigator}
        options={{ title: 'Rotalar', headerShown: false, tabBarIcon: tabIcon('map-marker-path') }}
      />
      <Tabs.Screen
        name="Profile"
        component={ProfileNavigator}
        options={{ title: 'Profil', headerShown: false, tabBarIcon: tabIcon('account') }}
      />
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      {token ? <AppTabs /> : <AuthFlow />}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
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
