import React from 'react';
import { ActivityIndicator, Pressable, View, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
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
  Ride: { followRouteId?: number } | undefined;
  Feed: undefined;
  Rides: undefined;
  Routes: undefined;
  Profile: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const RoutesStack = createNativeStackNavigator<RoutesStackParams>();
const FeedStack = createNativeStackNavigator<FeedStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();
const Tabs = createBottomTabNavigator<AppTabParams>();

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
            <Pressable onPress={() => navigation.navigate('Follows')} hitSlop={12} style={{ marginRight: spacing.sm }}>
              <MaterialCommunityIcons name="account-multiple" size={24} color={colors.primary} />
            </Pressable>
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
            <View style={{ flexDirection: 'row', gap: spacing.md, marginRight: spacing.sm }}>
              <Pressable onPress={() => navigation.navigate('GroupJoin')} hitSlop={12}>
                <MaterialCommunityIcons name="account-group" size={24} color={colors.primary} />
              </Pressable>
              <Pressable onPress={() => navigation.navigate('Explore')} hitSlop={12}>
                <MaterialCommunityIcons name="compass-outline" size={24} color={colors.primary} />
              </Pressable>
            </View>
          ),
        })}
      />
      <RoutesStack.Screen name="Explore" component={ExploreScreen} options={{ title: 'Keşfet' }} />
      <RoutesStack.Screen name="RouteCreate" component={RouteCreateScreen} options={{ title: 'Yeni Rota' }} />
      <RoutesStack.Screen name="RouteDetail" component={RouteDetailScreen} options={{ title: 'Rota' }} />
      <RoutesStack.Screen name="GroupJoin" component={GroupJoinScreen} options={{ title: 'Grup Sürüşü' }} />
      <RoutesStack.Screen name="GroupRide" component={GroupRideScreen} options={{ title: 'Grup Sürüşü' }} />
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

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <MaterialCommunityIcons name={name} color={color} size={size} />
  );
}

function AppTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface, shadowColor: 'transparent', elevation: 0 },
        headerTitleStyle: { color: colors.text, fontWeight: '800', letterSpacing: 0.5 },
        headerTintColor: colors.primary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 58 + insets.bottom,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="Ride"
        component={MapScreen}
        options={{ title: 'Sürüş', tabBarIcon: tabIcon('motorbike') }}
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
});
