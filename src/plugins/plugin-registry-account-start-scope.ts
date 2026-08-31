import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PluginRegistryAccountStartScope = Readonly<{
  channelId: string;
  retainRegistry: () => void;
}>;

const PLUGIN_REGISTRY_ACCOUNT_START_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRegistryAccountStartScope",
);

const pluginRegistryAccountStartScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRegistryAccountStartScope>
>(
  PLUGIN_REGISTRY_ACCOUNT_START_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRegistryAccountStartScope>(),
);

/** Runs one channel account startup lifetime with its plugin-registry owner. */
export function withPluginRegistryAccountStartScope<T>(
  scope: PluginRegistryAccountStartScope,
  run: () => T,
): T {
  return pluginRegistryAccountStartScope.run(scope, run);
}

/** Marks the current account when it retains state in its plugin registry generation. */
export function retainPluginRegistryForCurrentAccount(channelId?: string): void {
  const scope = pluginRegistryAccountStartScope.getStore();
  if (scope && (!channelId || scope.channelId === channelId)) {
    scope.retainRegistry();
  }
}
