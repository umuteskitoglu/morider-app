import React from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';

import { ChatStackParams } from '../navigation/RootNavigator';
import { CommentsView } from '../components/CommentsView';
import { communityCommentEndpoints } from '../lib/communities';

type Props = NativeStackScreenProps<ChatStackParams, 'CommunityComments'>;

// Same thin host as the feed's CommentsScreen; only the API paths differ.
export default function CommunityCommentsScreen({ route }: Props) {
  const headerHeight = useHeaderHeight();
  const { postId } = route.params;
  return (
    <CommentsView
      postId={postId}
      keyboardOffset={headerHeight}
      endpoints={communityCommentEndpoints(postId)}
    />
  );
}
