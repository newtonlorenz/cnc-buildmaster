/** Presentation of observed controller evidence; never movement authority. */
export function machineStatusEvidence(state: {
  offline?: boolean; demo?: boolean; phase?: string;
  controllerReport?: {
    fresh?: boolean; ageMs?: number;
    status?: { state?: string; overrides?: { feed?: number | null } };
  };
} | null | undefined, online: boolean): {
  fresh: boolean; controller: string; feed: string; nonDefaultFeed: boolean;
  notice: string | null;
} | null;
