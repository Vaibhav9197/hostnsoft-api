import { z } from "zod";
import { prisma } from "../lib/prisma";

// Shared by all three submission paths — see docs/request-feature-req.md.
// Kept as one function so the actual persistence (and its shape) can't
// drift between the dashboard, public, and agent routes.
// feature / feedback / other: the original three, still what the dashboard
// widget and the public contact form send. The rest (added 2026-09-29) let an
// agent say what kind of problem it hit, so reports can be triaged without
// reading every message: platform_bug (Embarko itself misbehaved),
// missing_capability (the app needs something Embarko lacks), docs_issue
// (the docs were wrong or unclear), unexpected_behavior (it worked, but not
// as documented).
export const FEATURE_REQUEST_TYPES = [
  "feature",
  "feedback",
  "other",
  "platform_bug",
  "missing_capability",
  "docs_issue",
  "unexpected_behavior",
] as const;
export const featureRequestTypeSchema = z.enum(FEATURE_REQUEST_TYPES);
export const featureRequestMessageSchema = z.string().trim().min(1).max(5000);

export interface CreateFeatureRequestInput {
  type: z.infer<typeof featureRequestTypeSchema>;
  message: string;
  source: "dashboard" | "public" | "agent";
  email?: string | null;
  userId?: string | null;
  companyId?: string | null;
  projectSlug?: string | null;
  agentName?: string | null;
}

export async function createFeatureRequest(input: CreateFeatureRequestInput) {
  return prisma.featureRequest.create({
    data: {
      type: input.type,
      message: input.message,
      source: input.source,
      email: input.email ?? null,
      userId: input.userId ?? null,
      companyId: input.companyId ?? null,
      projectSlug: input.projectSlug ?? null,
      agentName: input.agentName ?? null,
    },
  });
}
