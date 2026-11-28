// Merge these matches inside the existing /databases/{database}/documents block.
// Reuse isMember() and isAdult() from the household rules.
// The sync account receives no household member document.
match /calendarSyncWriters/{uid} {
  allow read, write: if false;
}

match /calendarEvents/{eventId} {
  allow read: if isMember();
  allow write: if request.auth != null
    && exists(/databases/$(database)/documents/calendarSyncWriters/$(request.auth.uid));
}

match /calendarAssignments/{eventId} {
  allow read: if isMember();
  allow create, update: if isAdult()
    && exists(/databases/$(database)/documents/calendarEvents/$(eventId))
    && request.resource.data.keys().hasOnly(['assignee'])
    && request.resource.data.assignee in ['', 'dad', 'mum', 'child1', 'child2', 'shared'];
}
