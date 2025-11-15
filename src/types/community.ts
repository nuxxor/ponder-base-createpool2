export type SocialLink = {
  platform: string;
  url: string;
  handle?: string;
};

export type CommunityLinks = {
  primaryWebsite?: string;
  websites?: string[];
  twitter?: string;
  telegram?: string;
  discord?: string;
  github?: string;
  socials?: SocialLink[];
  raw?: SocialLink[];
};
