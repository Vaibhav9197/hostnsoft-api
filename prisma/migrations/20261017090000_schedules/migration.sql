-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "path" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "alertWebhookUrl" TEXT,
    "nextRunAt" DATETIME,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "failing" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Schedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduleRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "responseExcerpt" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    CONSTRAINT "ScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Schedule_projectId_idx" ON "Schedule"("projectId");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduleRun_scheduleId_startedAt_idx" ON "ScheduleRun"("scheduleId", "startedAt");
