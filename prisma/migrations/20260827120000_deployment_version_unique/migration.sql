-- CreateIndex
CREATE UNIQUE INDEX "Deployment_projectId_version_key" ON "Deployment"("projectId", "version");

