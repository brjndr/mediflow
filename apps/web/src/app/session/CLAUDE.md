# How a session ends in the web app

Moved out of the root `CLAUDE.md` (#370), which keeps the rule; Claude Code loads this file when a file of this folder is read. Read it before changing or using what is here.

the idle time comes from the tenant config (`auth.idleTimeoutMinutes`, 30 minutes when absent). A dialog asks during the last minute, with focus on staying signed in so that a key pressed out of habit never ends the session (Escape stays too), and from then on only its buttons count as activity. Activity and sign-in or sign-out are shared between tabs over a `BroadcastChannel` that carries fixed words and no data. Every ending (sign-out, idle, another tab, a 401 from the server) goes through `endSessionLocally`, which drops all cached data and client state before the login page shows, and after a sign-out or an idle timeout the address of the open screen is not kept for whoever signs in next (after a 401 it is, since the user was at work).
