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
