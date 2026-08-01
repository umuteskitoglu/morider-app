import { createNavigationContainerRef } from '@react-navigation/native';

// Type-only import: erased at compile time, so no runtime require cycle even
// though RootNavigator (indirectly) imports this module.
import type { AppTabParams } from './RootNavigator';

// Container-level navigation handle for code that lives outside any screen
// (e.g. the onboarding tour overlay).
export const navigationRef = createNavigationContainerRef<AppTabParams>();

// Best-effort tab switch; silently ignored until the container is ready.
export function navigateToTab(tab: string) {
  if (navigationRef.isReady()) {
    navigationRef.navigate(tab as never);
  }
}

// Best-effort jump to a screen inside a tab's stack. Reports whether it landed,
// so a caller that arrived before the container mounted (a push tapped on a cold
// start) can queue and retry instead of silently losing the destination.
export function navigateNested(tab: string, screen: string, params?: object): boolean {
  if (!navigationRef.isReady()) return false;
  // The typed overloads cannot express "any tab, any nested screen" for a
  // caller that only learns both at runtime (a push payload), so the call is
  // made through a widened signature. lib/notificationRoute is the single place
  // that decides the pair, and its mapping is checked there.
  //
  // `initial: false` is required: by default React Navigation replaces the
  // target tab's whole nested stack with just the destination screen (the
  // stack's real initial screen never gets pushed underneath it), which
  // leaves it with nothing to go back to — the header back button silently
  // disappears until the app is restarted and the stack rebuilds normally.
  // This is most visible on tabs other than the default one, since their
  // stacks are lazily mounted and haven't initialized their own history yet
  // the first time a notification jumps into them this session.
  const navigate = navigationRef.navigate as unknown as (name: string, params?: object) => void;
  navigate(tab, { screen, params, initial: false });
  return true;
}
