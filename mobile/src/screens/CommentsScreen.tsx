import React from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';

import { FeedStackParams } from '../navigation/RootNavigator';
import { CommentsView } from '../components/CommentsView';

type Props = NativeStackScreenProps<FeedStackParams, 'Comments'>;

export default function CommentsScreen({ route }: Props) {
  // The screen sits under a navigation header; offset the keyboard avoider by
  // its height so the composer lands right above the keyboard.
  const headerHeight = useHeaderHeight();
  return <CommentsView postId={route.params.postId} keyboardOffset={headerHeight} />;
}
