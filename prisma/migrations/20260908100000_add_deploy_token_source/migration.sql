-- Track where each deploy token was minted: "dashboard" (a person in the
-- UI) or "agent" (the public email endpoint). Existing rows all predate the
-- public endpoint, so the default is correct for them.
ALTER TABLE "DeployToken" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'dashboard';
