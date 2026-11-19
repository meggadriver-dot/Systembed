# Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Owner Integrity**: Every user profile (`/users/{userId}`), secret (`/users/{userId}/secrets/{secretId}`), API key (`/api_keys/{keyId}`), media item (`/media_items/{mediaKey}`), media source (`/media_items/{mediaKey}/sources/{sourceId}`), and import job (`/import_jobs/{jobId}`) must match the authenticated user's verified `request.auth.uid` on creation, and `ownerId`/`uid`/`createdAt` are immutable afterward.
2. **Master Gate on Subcollections**: A `MediaSource` under `/media_items/{mediaKey}/sources/{sourceId}` cannot exist without its parent `/media_items/{mediaKey}` existing and matching both ownership (`ownerId == request.auth.uid || isAdmin()`) and `parentStatus`.
3. **PII & Secret Isolation**: `/users/{userId}` and `/users/{userId}/secrets/{secretId}` contain PII and TMDB secrets and are strictly readable/writable only by the owner (`request.auth.uid == userId`) or a verified admin.
4. **No Self-Assigned Privileges**: Users cannot write to `/admins/{userId}` unless they are already an admin (`diogosandro07@gmail.com` verified or listed in `/admins`).
5. **Strict Bounds & Types**: Every string has a bounded `.size()`, every array has `.size() <= MAX`, and document IDs match `^[a-zA-Z0-9_\-]+$` (`<= 128` chars).

## 2. The "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Write**: Creating a `media_items` doc when `request.auth == null`.
2. **Unverified Email Write**: Creating an `api_keys` doc when `request.auth.token.email_verified == false`.
3. **Owner Spoofing**: Creating `/api_keys/cv_live_hack` with `ownerId: "victim_uid"` while signed in as `attacker_uid`.
4. **Ghost Field Injection (Shadow Update)**: Updating `/media_items/movie_550` with extra field `isAdminApproved: true`.
5. **PII Blanket Read**: Listing `/users` or getting `/users/victim_uid` as `attacker_uid`.
6. **Secret Theft**: Reading `/users/victim_uid/secrets/tmdb` as `attacker_uid`.
7. **API Key Scraping**: Running `list` on `/api_keys` without filtering `ownerId == request.auth.uid`.
8. **ID Poisoning**: Creating `/media_items/` with a 300-character or invalid-character ID (`movie$bad`).
9. **Immutable Timestamp Tampering**: Creating a `media_items` doc with a backdated `createdAt` not equal to `request.time`, or changing `createdAt` on update.
10. **Orphaned Subcollection Source**: Creating `/media_items/nonexistent_999/sources/src1` when parent `/media_items/nonexistent_999` does not exist.
11. **Non-Admin Settings Override**: Updating `/settings/platform` as a regular developer account.
12. **Privilege Escalation**: Creating `/admins/attacker_uid` while signed in as `attacker_uid`.
