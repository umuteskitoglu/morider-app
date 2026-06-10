import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// The emergency contact lives only on this device (privacy: it is never sent
// to the backend).
const CONTACT_KEY = 'morider.emergencyContact';

export async function getEmergencyContact(): Promise<string> {
  return (await AsyncStorage.getItem(CONTACT_KEY)) ?? '';
}

export async function setEmergencyContact(phone: string): Promise<void> {
  const clean = phone.trim();
  if (clean) await AsyncStorage.setItem(CONTACT_KEY, clean);
  else await AsyncStorage.removeItem(CONTACT_KEY);
}

function emergencyBody(lat?: number, lon?: number): string {
  const loc = lat != null && lon != null ? `Konumum: https://maps.google.com/?q=${lat},${lon}` : 'Konum alınamadı.';
  return `Morider kaza algılaması: Bir kaza geçirmiş olabilirim, lütfen bana ulaş! ${loc}`;
}

/**
 * Opens the SMS composer prefilled for the emergency contact. Mobile OS'es do
 * not allow silent SMS sending from a non-default SMS app, so the last step
 * (tapping send) stays with the user / a bystander.
 */
export async function composeEmergencySMS(phone: string, lat?: number, lon?: number): Promise<void> {
  const body = encodeURIComponent(emergencyBody(lat, lon));
  const sep = Platform.OS === 'ios' ? '&' : '?';
  await Linking.openURL(`sms:${phone}${sep}body=${body}`);
}

/** Starts a phone call to the national emergency number (112). */
export async function call112(): Promise<void> {
  await Linking.openURL('tel:112');
}
