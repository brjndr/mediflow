import type { ReactNode } from 'react';
import type { Registry } from './registry';
import { RegistryContext } from './registry-context';

export function RegistryProvider({
  registry,
  children,
}: {
  registry: Registry;
  children: ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}
