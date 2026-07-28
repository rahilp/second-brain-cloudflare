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
  viaProvenance: EdgeProvenance; // how the traversed edge was created: explicit (you) / inferred (auto) / system
  viaLinkedAt: number;           // when the traversed edge was formed (edge created_at)
  viaFrom: string;               // id of the node this neighbor was reached from
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
  provenance: EdgeProvenance; // explicit (you linked) / inferred (auto) / system
  linkedAt: number;           // when the edge was formed (edge created_at)
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
  edges: { source: string; target: string; type: string; weight: number; provenance: EdgeProvenance }[];
}
