import React from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { FeedStackParams } from '../navigation/RootNavigator';
import { CommentsView } from '../components/CommentsView';

type Props = NativeStackScreenProps<FeedStackParams, 'Comments'>;

export default function CommentsScreen({ route }: Props) {
  return <CommentsView postId={route.params.postId} />;
}
