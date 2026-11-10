UPDATE "Application"
SET "status" = (
  SELECT "outcome"
  FROM "Review"
  WHERE "Review"."applicationId" = "Application"."id"
  ORDER BY "createdAt" DESC, "id" DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "Review"
  WHERE "Review"."applicationId" = "Application"."id"
);
