// Dark map style for the ride/navigation map (Google provider via
// MapView's customMapStyle). Matches the app's asphalt-black theme so the map
// doesn't glare white at night. Apple Maps ignores this and uses
// userInterfaceStyle instead. Compact Google "night mode" palette.
export const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#1d2530' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8c8c94' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0b' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#9aa0a6' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1b3326' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2f3a' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#b0b3b8' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3f4b' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f242e' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2a2f3a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a6079' }] },
];
