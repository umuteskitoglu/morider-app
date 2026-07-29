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

/**
 * Opens the SMS composer with a harmless test message. The emergency contact is
 * the one field whose mistakes only surface at the worst possible moment — a
 * digit dropped here is discovered after a crash — so the rider gets a way to
 * prove the number reaches someone while nothing is at stake.
 */
export async function composeTestSMS(phone: string): Promise<void> {
  const body = encodeURIComponent(
    'Morider testi: Bir kaza durumunda acil durum kişim olarak sana mesaj gidecek. Bu bir testtir, bir şey yapmana gerek yok.',
  );
  const sep = Platform.OS === 'ios' ? '&' : '?';
  await Linking.openURL(`sms:${phone}${sep}body=${body}`);
}

/** Starts a phone call to the national emergency number (112). */
export async function call112(): Promise<void> {
  await Linking.openURL('tel:112');
}
