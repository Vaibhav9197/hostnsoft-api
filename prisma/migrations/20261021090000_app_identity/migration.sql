-- CreateTable
CREATE TABLE "SlugAlias" (
    "slug" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlugAlias_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SlugAlias_projectId_idx" ON "SlugAlias"("projectId");
