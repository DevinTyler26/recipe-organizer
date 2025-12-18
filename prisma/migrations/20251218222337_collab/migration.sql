-- AlterTable
ALTER TABLE "Collaboration" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "Collaboration_resource_idx" RENAME TO "Collaboration_resourceType_resourceId_idx";

-- RenameIndex
ALTER INDEX "Collaboration_unique_share_idx" RENAME TO "Collaboration_resourceType_resourceId_collaboratorId_key";
