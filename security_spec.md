# Security Specification — Velo Firestore Rules

## 1. Data Invariants
1. A user document (`/users/{userId}`) can only be read or written by the authenticated user whose `request.auth.uid == userId` and `request.auth.token.email_verified == true`.
2. A `LikedTrack` (`/users/{userId}/likedTracks/{entryId}`) must have `ownerId == request.auth.uid`, `entryId == entryId`, valid YouTube `id`, optional valid `startSeconds`/`endSeconds` bounds (`startSeconds < endSeconds`), and `addedAt == request.time`.
3. A `Playlist` (`/users/{userId}/playlists/{playlistId}`) must have `ownerId == request.auth.uid`, `id == playlistId`, non-empty `name` (<= 100 chars), immutable `createdAt`, and `updatedAt == request.time`.
4. A `PlaylistTrack` (`/users/{userId}/playlists/{playlistId}/tracks/{entryId}`) requires its parent playlist to exist and belong to `request.auth.uid` (Master Gate via `existsAfter` / `getAfter`), `entryId == entryId` (allowing the same video `id` multiple times with distinct `entryId`), optional valid `startSeconds`/`endSeconds` clip range, and `addedAt == request.time`.
5. A `SearchHistoryItem` (`/users/{userId}/searchHistory/{historyId}`) must have `ownerId == request.auth.uid`, `id == historyId`, non-empty `query` (<= 200 chars), valid `searchType` (`keyword | channel | url`), and server timestamps.
6. A `PlayHistoryItem` (`/users/{userId}/playHistory/{trackId}`) must have `ownerId == request.auth.uid`, valid `id == trackId`, monotonic `playCount` (`1` on create, `existing().playCount + 1` on update), immutable `createdAt`, and `lastPlayedAt == request.time`.
7. A `PersonalTrack` (`/users/{userId}/personalTracks/{trackId}`) is strictly private to its authenticated owner (`isOwner(userId)` & `ownerId == request.auth.uid`), with `source == 'local'`, bounded file metadata, immutable `id`/`ownerId`/`source`/`fileName`/`fileSize`/`createdAt`, and optional `source` (`youtube` | `local`) validated on `LikedTrack` and `PlaylistTrack`.
8. No shadow/ghost keys are permitted on any create or update operation (`keys().hasOnly(...)` + `affectedKeys().hasOnly(...)`).
