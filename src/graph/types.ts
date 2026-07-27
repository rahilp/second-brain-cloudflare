import type { MemoryKind } from "../memory/kind";
import type { MemoryStatus } from "../memory/status";

export const EDGE_TYPES = {
  relates_to:      { directed: false, label: "Related to",      allowedKinds: null },
  supersedes:      { directed: true,  label: "Supersedes",      allowedKinds: null },
  caused_by:       { directed: true,  label: "Caused by",       allowedKinds: null },
  decided:         { directed: true,  label: "Decided",         allowedKinds: ["episodic"] },
  about_person:    { directed: true,  label: "About person",    allowedKinds: null },
  part_of_project: { directed: true,  label: "Part of project", allowedKinds: null },
  follows:         { directed: true,  label: "Follows",         allowedKinds: ["episodic"] },
} as const satisfies Record<string, { directed: boolean; label: string; allowedKinds: readonly MemoryKind[] | null }>;

export type EdgeType = keyof typeof EDGE_TYPES;

export const PROVENANCE_VALUES = ["explicit", "inferred", "system"] as const;
export type EdgeProvenance = (typeof PROVENANCE_VALUES)[number];

export interface GraphNeighbor {
  id: string;
  hop: number;
  viaWeight: number;
  viaType: EdgeType;
}

export interface Connection {
  id: string;
  content: string;
  tags: string[];
  source: string;
  created_at: number;
  type: EdgeType;
  label: string;
  weight: number;
}

export interface GraphNode {
  id: string;
  label: string;
  tags: string[];
  kind: MemoryKind | null;
  status: MemoryStatus | null;
  importance: number;
  created_at: number;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: { source: string; target: string; type: string; weight: number }[];
}
