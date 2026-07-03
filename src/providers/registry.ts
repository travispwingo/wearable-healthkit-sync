/**
 * Provider registry — the single place new wearables are wired in.
 *
 * Each entry is a factory that, given the Worker env, resolves credentials
 * (provider-specific auth) and returns a ready HealthProvider. To add Garmin:
 * implement a provider under providers/garmin/ and add one line here.
 */
import type { Env } from "../env";
import type { HealthProvider } from "./types";
import { createOuraProvider } from "./oura";
import { getAccessToken } from "./oura/oauth";

export type ProviderFactory = (env: Env) => Promise<HealthProvider>;

export const providers: Record<string, ProviderFactory> = {
  oura: async (env) => {
    const accessToken = await getAccessToken(env);
    return createOuraProvider({
      accessToken,
      // Default to the HealthKit-native fraction (0.96); env can flip to raw percent.
      spo2AsFraction: env.SPO2_AS_FRACTION !== "false",
      apiBase: env.OURA_API_BASE,
    });
  },
  // garmin: async (env) => { ... }  ← future, see README "Extending to other wearables"
};

export function getProviderFactory(id: string): ProviderFactory | undefined {
  return providers[id];
}
