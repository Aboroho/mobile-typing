You are a senior full-stack architect and autonomous software engineer.

Build a complete, production-oriented, mobile-first private messaging web application using Next.js. You must work autonomously and should not ask me for confirmation before making implementation decisions. When requirements are ambiguous, choose the most secure, maintainable, and practical solution, document your decision, and continue working.

Do not merely create a prototype or mock interface. Implement the actual application architecture, database integration, authentication, real-time messaging, media handling, audio calling, administration, and security controls described below.

==================================================
1. PROJECT OVERVIEW
==================================================

Build a secret-access, WhatsApp-inspired, one-to-one messaging application.

The application must initially appear to be a typing-practice game. Users must not be told that the application is a chat application until they successfully enter the secret code.

The application will initially be used through mobile browsers. The architecture must be reusable by a future React Native mobile application.

The application must support:

- One-to-one text messaging
- Emoji messages
- Image sharing
- One-time-view images
- Voice messages
- One-to-one audio calls
- Message editing
- Message deletion from the ordinary user interface without physically deleting the database record
- Real-time message updates
- An administrator interface
- Administrative access to conversations and deleted media
- A secret-code access mechanism
- A typing-practice game shown before every chat access
- Mobile-first, WhatsApp-inspired user experience

The administrator must be able to configure the secret code through the admin panel.

==================================================
2. REQUIRED TECHNOLOGY STACK
==================================================

Use the following technologies unless there is a strong technical reason to replace one. If you replace anything, document the reason.

Frontend and application framework:

- Next.js with the App Router
- TypeScript with strict mode enabled
- React
- Tailwind CSS
- shadcn/ui where useful
- Zustand or an equally suitable lightweight state-management solution
- React Hook Form
- Zod for validation

Backend and infrastructure:

- Next.js Route Handlers or a clearly separated backend API layer
- Firebase Authentication
- Cloud Firestore
- Firebase Storage
- Firebase Admin SDK for trusted server-side operations
- WebRTC for audio calls
- A signaling mechanism using the backend and/or Firestore
- STUN/TURN support for WebRTC
- Vercel-compatible deployment

Use Firebase security rules and server-side authorization wherever appropriate.

Do not expose Firebase Admin credentials or other private secrets to the client.

==================================================
3. ARCHITECTURE REQUIREMENTS
==================================================

The project must be designed so that a future React Native application can reuse the same backend and business logic.

Use a modular architecture with clear separation between:

- UI components
- Client-side state
- API clients
- Domain types
- Validation schemas
- Authentication
- Messaging services
- Media services
- Call services
- Admin services
- Firebase infrastructure
- Shared utilities

Use versioned API routes, for example:

/api/v1/auth/...
/api/v1/users/...
/api/v1/conversations/...
/api/v1/messages/...
/api/v1/media/...
/api/v1/calls/...
/api/v1/admin/...
/api/v1/access/...

Do not tightly couple business logic to React components.

All important domain types and validation schemas should be reusable by future clients.

Use consistent API response formats, error handling, logging, and HTTP status codes.

==================================================
4. RECOMMENDED PROJECT STRUCTURE
==================================================

Create a maintainable structure similar to the following:

/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   │   ├── (public)/
│   │   │   │   └── typing-game/
│   │   │   ├── (authenticated)/
│   │   │   │   ├── conversations/
│   │   │   │   ├── settings/
│   │   │   │   └── profile/
│   │   │   ├── admin/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── users/
│   │   │   │   ├── conversations/
│   │   │   │   ├── messages/
│   │   │   │   ├── media/
│   │   │   │   ├── calls/
│   │   │   │   └── settings/
│   │   │   ├── api/
│   │   │   │   └── v1/
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx
│   │   ├── components/
│   │   │   ├── typing-game/
│   │   │   ├── auth/
│   │   │   ├── conversations/
│   │   │   ├── messages/
│   │   │   ├── media/
│   │   │   ├── voice-messages/
│   │   │   ├── audio-calls/
│   │   │   ├── admin/
│   │   │   └── ui/
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   ├── firebase/
│   │   │   ├── auth/
│   │   │   ├── access/
│   │   │   ├── api/
│   │   │   ├── realtime/
│   │   │   └── browser/
│   │   ├── stores/
│   │   ├── styles/
│   │   └── public/
│   │       └── typing-words/
│   └── mobile/
│       └── README.md
├── packages/
│   ├── types/
│   ├── validation/
│   ├── api-client/
│   ├── domain/
│   ├── config/
│   └── utils/
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   ├── storage.rules
│   ├── seed/
│   └── README.md
├── scripts/
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── database-schema.md
│   ├── security.md
│   ├── deployment.md
│   └── decisions.md
├── .env.example
├── package.json
├── README.md
└── turbo.json or equivalent workspace configuration

You may adapt this structure if necessary, but preserve the separation of concerns.

==================================================
5. FIRST-VISIT AND ACCESS FLOW
==================================================

Every visitor must initially see only the typing-practice game.

This applies to:

- Unregistered users
- Registered but logged-out users
- Logged-in users
- Administrators, unless a secure admin bypass is explicitly implemented

The user must not see obvious chat-related text, branding, routes, or UI before access is granted.

The initial page should look like a normal typing-practice application.

The application must not reveal that it contains a chat system.

The user can type words in the game and, if the secret code is detected, the application proceeds to the appropriate authentication flow.

Access behavior:

1. Unregistered user:
   - User plays the typing game.
   - User enters the secret code.
   - Show a registration form containing:
     - Name
     - Email
     - Password
     - Confirm password if appropriate
   - Register the user.
   - Establish an authenticated session.
   - Permit access to the messaging interface.

2. Registered but logged-out user:
   - User plays the typing game.
   - User enters the secret code.
   - Show a login form containing:
     - Email
     - Password
   - Authenticate the user.
   - Permit access to the messaging interface.

3. Registered and already logged-in user:
   - User plays the typing game.
   - User enters the secret code.
   - Ask only for the user's password.
   - Verify the password securely.
   - Permit access to the messaging interface.

The exact implementation of reauthentication may use Firebase reauthentication or a secure server-side verification flow.

Do not rely solely on a client-side boolean such as `isUnlocked`.

==================================================
6. SECRET-CODE IMPLEMENTATION
==================================================

The secret code has the following properties:

- It is configured by the administrator through the admin panel.
- It is case-sensitive.
- It is no longer than 15 characters.
- It must match a consecutive substring of the user's keystroke stream.
- Characters must appear consecutively.
- For example:
  - Secret: `abc`
  - Input: `xxabczz` → match
  - Input: `axbyc` → no match
- The application must maintain a rolling keystroke buffer of no more than 15 characters.
- The code should be checked locally in the browser while the typing game is active.
- The application must not send every keystroke to the server.
- The current secret code may be delivered to the browser when the typing-game session begins.
- The server must still validate access before allowing protected application operations.
- The secret code must never be displayed in the UI.
- The code must be case-sensitive.
- The code may contain letters, numbers, or symbols unless the admin panel explicitly restricts the allowed character set.

Implement the rolling buffer efficiently:

- Add each new keystroke to the buffer.
- Trim the buffer to the maximum configured length.
- Check whether the secret code is a consecutive substring.
- Prevent duplicate unlock events.
- Avoid capturing keystrokes when the user is typing into a password, email, or other authentication field.
- Avoid interfering with normal typing-game input.
- Handle mobile virtual keyboards correctly.
- Use `keydown`, `beforeinput`, or another appropriate browser event strategy as needed.
- Do not record or transmit the complete user's typing history.

Important security limitation:

Because the secret code is intentionally sent to the browser, a technically skilled user may inspect the client-side JavaScript and discover it. This is an accepted product requirement. Nevertheless, the server must independently protect all private application data and must not trust the client-side unlock state.

Store and manage the secret securely on the server. Use appropriate access control for changing it.

When the administrator changes the code, establish a clear strategy for invalidating old access challenges or sessions.

==================================================
7. TYPING-PRACTICE GAME
==================================================

The game must be the default screen before every chat access.

Requirements:

- User can choose:
  - Bengali
  - English
- Maintain approximately 500–1,000 frequently used words for each language.
- Store the word lists in a maintainable frontend data file or equivalent static asset.
- Select words randomly.
- Display one word at a time.
- After the user correctly completes a word, automatically display another word.
- The user does not need to complete the game to unlock the application.
- The game must support a configurable duration, such as:
  - 30 seconds
  - 60 seconds
  - 120 seconds
- Display:
  - Current word
  - Input area
  - Correct words
  - Incorrect characters or words
  - Typing speed
  - Accuracy
  - Remaining time
- At the end of the game, display:
  - Score
  - Words per minute or an equivalent score
  - Accuracy
  - Replay button
- The secret-code detector must continue working while the user is playing.
- The game must be usable on mobile devices with virtual keyboards.
- The game must not reveal the secret-code functionality.

The game should look polished and lightweight, not like a placeholder.

==================================================
8. TRIPLE-TAP BEHAVIOR
==================================================

When the user triple-taps the screen:

- Immediately hide the chat interface.
- Return to the typing-practice game.
- Clear the current client-side unlocked state.
- Require the appropriate access process again before reopening the chat.
- Ensure that a triple tap does not accidentally trigger unwanted browser behavior.
- Implement a reliable triple-tap detector with:
  - Time threshold
  - Distance threshold
  - Touch and pointer-event support
  - Prevention of false positives where practical

During an active audio call:

- Handle triple-tap consistently.
- Do not silently leave the call in an unstable state.
- If necessary, show a minimal confirmation or safely terminate the call before returning to the game.
- Document the chosen behavior.

==================================================
9. BROWSER MINIMIZATION AND VISIBILITY
==================================================

Use the Page Visibility API and appropriate lifecycle events.

When the browser tab becomes hidden or the page is minimized:

- Hide or lock the chat interface.
- Invalidate the current client-side chat-unlocked state.
- When the user returns, show the typing-practice game.
- Require the access flow again before displaying the chat.

Do not claim that browser behavior can be controlled perfectly. Handle the following as well as the platform allows:

- Tab switching
- Browser minimization
- Backgrounding a mobile browser
- Screen locking
- Page reloads
- Browser back navigation

If an active audio call exists when the page becomes hidden, implement a safe, documented policy. Prefer terminating or suspending the call rather than leaving it in an unpredictable state.

==================================================
10. AUTHENTICATION AND USER MANAGEMENT
==================================================

Use Firebase Authentication with email and password.

User profile fields should include at least:

- User ID
- Name
- Email
- Profile photo URL, if supported
- Account creation timestamp
- Last login timestamp
- Account status
- Created/updated timestamps

Implement:

- Registration
- Login
- Logout
- Password reauthentication
- Password reset if appropriate
- Session persistence
- Protected routes
- Server-side token verification
- Account status checks
- Rate limiting where practical
- Secure error messages that do not reveal whether an email exists

Do not expose sensitive authentication information in logs or client responses.

==================================================
11. ADMINISTRATION
==================================================

There must be an administrator.

The administrator identity must be configured through an environment variable, such as:

ADMIN_UID

Never expose this value through a public environment variable.

Admin authorization must be verified server-side using a Firebase Admin SDK token and the configured administrator UID.

Build an admin panel with at least the following sections:

1. Dashboard
   - Total users
   - Active users
   - Conversation count
   - Message count
   - Media count
   - Recent activity

2. Secret-code management
   - View whether a code is configured
   - Change the secret code
   - Validate maximum length of 15 characters
   - Enforce case sensitivity
   - Confirm changes
   - Record an audit log
   - Never display the code in plaintext unnecessarily

3. User management
   - List users
   - Search users
   - View user profile
   - View account status
   - Disable or reactivate users if supported

4. Conversation inspection
   - Select any two users
   - View their conversation
   - Search messages
   - View deleted messages
   - View edited-message history if implemented

5. Media inspection
   - View uploaded images
   - View one-time-view images
   - View deleted images
   - View metadata
   - View voice-message media where permitted

6. Call history
   - View audio-call records
   - View participants
   - View timestamps
   - View call status and duration

7. Audit logs
   - Secret-code changes
   - Admin access to conversations
   - Admin media access
   - User-status changes
   - Other sensitive administrative actions

Administrative access must be logged.

The UI should clearly distinguish normal user functionality from administrative functionality.

==================================================
12. ONE-TO-ONE CONVERSATIONS
==================================================

Only one-to-one conversations are permitted.

Do not implement group chats.

A conversation must contain exactly two participants.

Implement:

- User search
- Starting a conversation with another user
- Conversation list
- Last-message preview
- Unread count
- Last activity timestamp
- Online or last-seen status if feasible
- Conversation deletion from the user's view if appropriate
- Blocking or reporting only if practical and documented

Prevent unauthorized users from reading conversations that do not involve them.

==================================================
13. TEXT MESSAGING
==================================================

Implement WhatsApp-inspired messaging behavior.

Support:

- Plain text messages
- Emoji messages
- Multiline messages
- Message timestamps
- Delivery state
- Read state
- Sending state
- Failed state
- Reply-to-message support if practical
- Infinite scrolling or pagination
- Real-time updates
- Optimistic UI with rollback on failure
- Retry failed messages
- Message search if practical

Use Firestore real-time listeners or an equivalent robust mechanism.

Validate and sanitize all message content.

Prevent abuse through:

- Maximum message length
- Rate limiting where practical
- Input validation
- Server-side authorization
- Safe rendering of user content

==================================================
14. MESSAGE EDITING
==================================================

Users may edit their own messages within 2 minutes of sending them.

Requirements:

- Only the original sender may edit a message.
- The edit window must be validated server-side.
- Edited messages must display an “edited” indicator.
- Preserve the original content or an edit history for administrative inspection.
- Do not allow editing after the 2-minute window.
- Handle offline or delayed requests safely.
- Apply the same rules to text messages and photos where technically appropriate.

For photos, define an appropriate editing behavior. At minimum, support replacing or updating the user's own sent media within 2 minutes if feasible. If actual binary replacement is unsafe or impractical, create a new version while preserving the original media for administrative access.

==================================================
15. MESSAGE AND MEDIA DELETION
==================================================

Users must be able to delete their own messages and photos from the ordinary user interface.

Deletion must not physically remove the underlying database record.

Use soft deletion.

For deleted messages or media:

- Hide the content from ordinary users according to the selected deletion policy.
- Preserve the original record for administrative inspection.
- Store:
  - Deleted status
  - Deleted timestamp
  - Deleted by user ID
  - Deletion reason if applicable
  - Original content or secure reference
- Ensure ordinary users cannot access content that should be hidden from them.
- Allow administrators to inspect deleted content.
- Log administrative access to deleted content.

Design the data model so that soft-deleted media cannot accidentally remain publicly accessible through an unprotected URL.

Do not permanently delete media files unless an explicit retention policy is later introduced.

==================================================
16. IMAGE SHARING
==================================================

Implement image sharing with Firebase Storage.

Support:

- Image selection from mobile devices
- Camera capture where supported
- Upload progress
- Upload cancellation
- Image previews
- Image compression or resizing
- Safe MIME-type validation
- File-size limits
- Secure storage paths
- Access-controlled image retrieval
- Upload failure handling
- Retry support

Do not trust the file extension supplied by the client.

Validate MIME type and file content as far as practical.

Avoid exposing unrestricted public Storage URLs.

==================================================
17. ONE-TIME-VIEW PHOTOS
==================================================

Implement a WhatsApp-inspired one-time-view photo feature.

Requirements:

- Sender can mark an image as “view once.”
- Recipient sees that a view-once image is available.
- Recipient must actively click or tap to open it.
- Once opened, it can be viewed only once by the recipient.
- After viewing, the image must no longer be available to that recipient.
- The sender must receive a real-time or near-real-time status update indicating that the image was viewed.
- Store the view event securely.
- Prevent repeated viewing through server-side state validation.
- Handle simultaneous requests safely and atomically.
- Admins must still be able to inspect the original image and its metadata.
- Preserve the image for administrative inspection even after the recipient has viewed it.

Possible states:

- SENT
- DELIVERED
- VIEWABLE
- VIEWING
- VIEWED
- EXPIRED
- DELETED

Use server-side authorization and transactional logic to prevent a recipient from opening the same image multiple times.

Screenshot prevention:

Attempt reasonable browser-level protections, such as:

- Hiding content when the page is backgrounded
- Preventing context-menu downloads where practical
- Avoiding direct public image URLs
- Rendering media through protected application routes
- Clearing the displayed image after viewing
- Preventing caching where practical

However, do not claim that screenshots can be completely prevented in a browser. Document this limitation clearly in the technical documentation.

==================================================
18. VOICE MESSAGES
==================================================

Implement voice-message recording using browser-supported APIs, such as MediaRecorder.

Support:

- Microphone permission handling
- Start recording
- Stop recording
- Cancel recording
- Recording duration
- Playback before sending if practical
- Upload progress
- Sending voice messages
- Playback controls
- Pause/resume
- Loading and error states
- Mobile browser compatibility handling

Store voice-message metadata, including:

- Sender
- Conversation
- Duration
- MIME type
- Storage reference
- Created timestamp
- Deleted status

Protect voice-message media with access-controlled retrieval.

==================================================
19. AUDIO CALLS
==================================================

Implement one-to-one audio calls using WebRTC.

The call feature must be initiated from a conversation.

Support:

- Start audio call
- Incoming-call UI
- Accept call
- Reject call
- Cancel outgoing call
- End active call
- Mute/unmute microphone
- Call duration
- Connection status
- Reconnection handling where practical
- Missed-call records
- Incoming and outgoing call history
- Call history displayed in the conversation
- Permission errors
- Device and browser compatibility errors

Use a secure signaling mechanism.

Do not assume that Vercel can act as a TURN server.

Support configurable STUN/TURN server credentials through environment variables.

The call data model should record at least:

- Call ID
- Conversation ID
- Initiator
- Recipient
- Call type
- Status
- Start timestamp
- Answer timestamp
- End timestamp
- Duration
- End reason
- Created/updated timestamps

When the browser becomes hidden or minimized:

- Follow the application's privacy behavior.
- Safely terminate or suspend the call according to the documented policy.
- Do not leave orphaned call sessions.

Triple-tap behavior must also be handled safely during calls.

==================================================
20. WHATSAPP-INSPIRED UI/UX
==================================================

The interface should be inspired by WhatsApp but must not copy copyrighted branding, logos, or proprietary assets.

Design goals:

- Mobile-first
- Responsive
- Fast
- Clean
- Familiar messaging layout
- Conversation list
- Chat header
- Message bubbles
- Message composer
- Emoji picker
- Attachment button
- Voice-recording button
- Audio-call button
- Read indicators
- Unread badges
- Typing indicators if implemented
- Accessible controls
- Dark mode support if practical
- Touch-friendly controls
- Smooth but restrained animations

The app should work well on narrow mobile screens.

Avoid unnecessary desktop-oriented layouts.

Use accessible labels, keyboard navigation where applicable, adequate contrast, and semantic HTML.

==================================================
21. DATABASE DESIGN
==================================================

Design and document a robust Firestore schema.

A possible schema includes:

users/{userId}

conversations/{conversationId}

conversations/{conversationId}/messages/{messageId}

userConversations/{userId}/items/{conversationId}

calls/{callId}

media/{mediaId}

typingSessions/{sessionId}

adminAuditLogs/{logId}

appConfig/access

You may improve this structure if needed.

Conversation records should include:

- Exactly two participant IDs
- Participant lookup key
- Last-message metadata
- Last-activity timestamp
- Created/updated timestamps

Message records should include:

- Message ID
- Conversation ID
- Sender ID
- Message type
- Text content or media reference
- Reply reference if supported
- Delivery status
- Read status
- Edited status
- Edit history reference
- Deleted status
- Created timestamp
- Updated timestamp
- Deleted timestamp
- Metadata

Media records should include:

- Media ID
- Owner
- Conversation ID
- Message ID
- Storage path
- Media type
- MIME type
- Size
- View-once flag
- View status
- Deletion status
- Created timestamp
- Updated timestamp

Use appropriate Firestore indexes.

Prevent unauthorized access through Firestore rules and server-side checks.

==================================================
22. SECURITY REQUIREMENTS
==================================================

Treat security as a first-class requirement.

Implement:

- Firebase Authentication
- Server-side Firebase token verification
- Server-side admin authorization
- Firestore security rules
- Storage security rules
- Input validation using Zod
- Rate limiting where practical
- Secure error handling
- CSRF protection where applicable
- XSS prevention
- Secure HTTP headers
- Content Security Policy where practical
- No secrets in client bundles except explicitly public configuration
- No private Firebase Admin credentials in frontend code
- No unrestricted media URLs
- Access checks on every protected API operation
- Ownership checks for message editing and deletion
- Atomic view-once state transitions
- Audit logs for sensitive admin actions
- Safe logging without passwords, tokens, secret codes, or private message content

Do not rely on hidden UI elements as a security mechanism.

The server must enforce every important permission.

==================================================
23. ENVIRONMENT VARIABLES
==================================================

Create a complete `.env.example`.

External secrets and service credentials will be supplied through environment variables.

Include placeholders for relevant values, such as:

NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

ADMIN_UID=

SECRET_CODE_MAX_LENGTH=15

NEXT_PUBLIC_APP_URL=

STUN_SERVER_URL=
TURN_SERVER_URL=
TURN_SERVER_USERNAME=
TURN_SERVER_CREDENTIAL=

Any other required environment variables should be documented.

Never hardcode real secrets.

Never expose private server-side environment variables through `NEXT_PUBLIC_` variables.

==================================================
24. API REQUIREMENTS
==================================================

Create a documented API layer.

At minimum, implement endpoints or equivalent service methods for:

Authentication:

- Get current user
- Reauthenticate user
- Account/profile operations

Access:

- Start typing-game access session
- Retrieve the current client-side secret configuration
- Validate or establish an access session
- Invalidate access session

Users:

- Search users
- Get user profile
- Update profile

Conversations:

- Create or find one-to-one conversation
- List conversations
- Get conversation details
- Mark conversation as read

Messages:

- Send message
- Edit message
- Soft-delete message
- List messages
- Mark message as delivered/read
- Retry failed message

Media:

- Create upload authorization
- Upload media
- Send media message
- View one-time media
- Mark media as viewed
- Soft-delete media

Voice messages:

- Create voice-message upload authorization
- Send voice message

Calls:

- Create call
- Signal call
- Accept call
- Reject call
- End call
- Retrieve call history

Admin:

- Get dashboard statistics
- Manage secret code
- List users
- Inspect conversations
- Inspect deleted messages
- Inspect media
- Inspect call history
- Retrieve audit logs

Document request and response formats, authorization requirements, validation rules, and error codes.

==================================================
25. TESTING REQUIREMENTS
==================================================

Write meaningful automated tests.

Include:

- Unit tests for secret-code substring detection
- Tests for rolling-buffer behavior
- Case-sensitivity tests
- Tests ensuring non-consecutive characters do not match
- Typing-game scoring tests
- Authentication-flow tests
- Message-validation tests
- Message-editing time-window tests
- Soft-deletion tests
- One-time-view atomicity tests
- Authorization tests
- Admin-access tests
- API integration tests
- WebRTC signaling tests where practical
- Responsive UI tests
- End-to-end tests using Playwright where practical

Test at least:

- Secret code at the beginning, middle, and end of the buffer
- Secret code longer than the current buffer
- Repeated unlock attempts
- Triple-tap behavior
- Page visibility changes
- Logged-out access
- Logged-in reauthentication
- Unauthorized conversation access
- Editing after 2 minutes
- Repeated one-time-photo viewing attempts
- Deleted-message visibility for ordinary users and admins

==================================================
26. PERFORMANCE REQUIREMENTS
==================================================

Optimize for mobile browsers and slow networks.

Implement:

- Lazy loading
- Image compression
- Pagination
- Efficient Firestore listeners
- Avoidance of unnecessary rerenders
- Optimistic updates where safe
- Upload progress indicators
- Proper loading states
- Error boundaries
- Offline-friendly behavior where practical
- Efficient bundle splitting
- Accessible and fast initial typing-game rendering

Do not load the entire chat application unnecessarily before the user unlocks access.

==================================================
27. DOCUMENTATION REQUIREMENTS
==================================================

Create documentation covering:

1. Project setup
2. Local development
3. Environment variables
4. Firebase project configuration
5. Firebase Authentication setup
6. Firestore setup
7. Storage setup
8. Firestore security rules
9. Storage security rules
10. Database schema
11. API documentation
12. Secret-code behavior
13. Privacy limitations
14. Screenshot-prevention limitations
15. WebRTC and TURN configuration
16. Admin configuration
17. Deployment to Vercel
18. Testing
19. Troubleshooting
20. Architectural decisions

The README must contain exact commands for:

- Installing dependencies
- Running the development server
- Running tests
- Running linting
- Building the project
- Deploying the application

==================================================
28. DEVELOPMENT WORKFLOW
==================================================

Work autonomously and continuously.

Follow this order:

1. Inspect the existing repository, if one exists.
2. Create or improve the project architecture.
3. Configure TypeScript, linting, formatting, and testing.
4. Implement the typing-game experience.
5. Implement the access and authentication flows.
6. Implement the database and security rules.
7. Implement users and one-to-one conversations.
8. Implement real-time text messaging.
9. Implement editing and soft deletion.
10. Implement image sharing.
11. Implement one-time-view images.
12. Implement voice messages.
13. Implement audio calls.
14. Implement the admin panel.
15. Add security controls and audit logging.
16. Add tests.
17. Optimize mobile performance.
18. Write documentation.
19. Run validation, linting, tests, and production builds.
20. Fix discovered errors before finishing.

Do not stop at scaffolding.

Do not leave core functionality as TODO comments.

If a third-party service or credential is unavailable, implement the integration interface, provide a clear configuration path, and use a safe development fallback only where appropriate. Clearly document anything that cannot be fully tested locally.

==================================================
29. CODE QUALITY REQUIREMENTS
==================================================

Use:

- Strict TypeScript
- Clear naming
- Small, composable functions
- Reusable components
- Domain-oriented services
- Typed API responses
- Centralized error handling
- Consistent formatting
- Meaningful comments only where necessary
- No unnecessary duplication
- No insecure shortcuts
- No fake security mechanisms
- No hardcoded secrets
- No unexplained magic numbers
- No unused dependencies
- No dead code

Avoid overengineering, but do not sacrifice security or maintainability.

==================================================
30. FINAL DELIVERY REQUIREMENTS
==================================================

When implementation is complete:

1. Run the type checker.
2. Run linting.
3. Run automated tests.
4. Run a production build.
5. Fix all errors that can be fixed.
6. Verify the main user flows.
7. Provide a concise implementation summary.
8. List all files and major modules created.
9. List all environment variables required.
10. Explain how to configure Firebase.
11. Explain how to configure the administrator.
12. Explain how to configure STUN/TURN.
13. Report any limitations honestly.
14. Do not claim that untested functionality is fully working.
15. Do not ask me for permission to continue with ordinary implementation decisions.

The final application must feel like a polished, private, mobile-first messaging application inspired by WhatsApp, while initially presenting itself only as a typing-practice game.
