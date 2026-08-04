// Core shared interfaces used across Mendr modules.

/** A single detected breaking change in a Stripe API spec. */
export interface ApiChange {
  kind: 'field_rename' | 'field_removed' | 'type_change' | 'enum_value_change';
  path: string;
  from?: string;
  to?: string;
}

/** A collection of API changes between two spec snapshots. */
export type ChangeSet = ApiChange[];

/** A location in a source file where an API surface is used. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Maps a Stripe API path/field to the source locations that use it. */
export type UsageMap = Record<string, SourceLocation[]>;

/** A change intersected with the concrete source locations it affects. */
export interface AffectedSite {
  change: ApiChange;
  locations: SourceLocation[];
}

/** Confidence tier for an auto-generated fix. */
export type Tier = 'A' | 'C';
