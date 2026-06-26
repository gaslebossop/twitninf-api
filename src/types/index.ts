export interface User {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
}

export interface Tweet {
  id: string;
  userId: string;
  content: string;
  createdAt: Date;
  likes: number;
  retweets: number;
  replies: number;
}

export interface Feed {
  tweets: Tweet[];
  nextToken?: string;
}
