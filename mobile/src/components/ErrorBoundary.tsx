import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button } from './ui';
import { colors, spacing } from '../theme';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

// Last line of defense: without this, ANY uncaught error thrown while
// rendering (a bad prop, a missing/mis-linked native module surfaced through a
// hook, etc.) unmounts the whole React tree and the app just closes with no
// trace on the rider's device. Catching it here trades that hard crash for a
// recoverable screen — "try again" simply remounts the app's children.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Uncaught render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.root}>
          <MaterialCommunityIcons name="alert-circle-outline" size={48} color={colors.primary} />
          <Text style={styles.title}>Bir şeyler ters gitti</Text>
          <Text style={styles.body}>
            Morider beklenmedik bir hatayla karşılaştı. Tekrar denemek genelde sorunu çözer.
          </Text>
          <Button title="Tekrar dene" onPress={() => this.setState({ error: null })} />
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '900' },
  body: { color: colors.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
});
