export const normalizeAddress = (address: string) =>
  address.toLowerCase() as `0x${string}`;

export const isAnchorToken = (address: string, anchors: Set<string>) =>
  anchors.has(normalizeAddress(address));
