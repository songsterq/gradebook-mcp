export type Identity =
  | { kind: 'user'; id: string; email: string; name?: string }
  | { kind: 'service'; id: string; name: string }
  | { kind: 'bearer' }
  | { kind: 'dev-insecure' };

export function describeIdentity(identity: Identity): string {
  switch (identity.kind) {
    case 'user':
      return `user:${identity.email}`;
    case 'service':
      return `service:${identity.name}`;
    case 'bearer':
      return 'bearer';
    case 'dev-insecure':
      return 'dev-insecure';
  }
}
