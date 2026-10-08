<!-- intent-skills:start -->

# TanStack Intent - before editing files, run the matching guidance command.

tanstackIntent:

- id: "@tanstack/ai#ai-core"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core"
  for: "Entry point for TanStack AI skills. Routes to chat-experience, tool-calling, media-generation, structured-outputs, adapter-configuration, ag-ui-protocol, middleware, locks, custom-backend-integration, and debug-logging, plus the skills shipped by companion packages (@tanstack/ai-persistence, @tanstack/ai-code-mode). Use chat() not streamText(), openaiText() not createOpenAI(), toServerSentEventsResponse() not manual SSE, middleware hooks not onEnd callbacks."
- id: "@tanstack/ai#ai-core/adapter-configuration"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/adapter-configuration"
  for: "Provider adapter selection and configuration: openaiText, anthropicText, geminiText, ollamaText, grokText, groqText, openRouterText, bedrockText, byteplusText, openaiCompatible. Per-model type safety with modelOptions, reasoning/thinking configuration, runtime adapter switching, extendAdapter() for custom models, createModel(). Generic OpenAI-compatible providers (DeepSeek, Together, Fireworks, etc.) via openaiCompatible({ baseURL, apiKey, models }) from @tanstack/ai-openai/compatible. API key env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY, XAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST, BEDROCK_API_KEY (or AWS_BEARER_TOKEN_BEDROCK). BytePlus needs TWO keys: ARK_API_KEY (ModelArk — chat/video/image) and BYTEPLUS_VOICE_API_KEY (Seed Speech — TTS/transcription); neither is a fallback for the other."
- id: "@tanstack/ai#ai-core/ag-ui-protocol"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/ag-ui-protocol"
  for: "Server-side AG-UI streaming protocol implementation: StreamChunk event types (RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, RUN_FINISHED, RUN_ERROR, STEP_STARTED/STEP_FINISHED, STATE_SNAPSHOT/DELTA, CUSTOM), toServerSentEventsStream() for SSE format, toHttpStream() for NDJSON format. For backends serving AG-UI events without client packages."
- id: "@tanstack/ai#ai-core/chat-experience"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/chat-experience"
  for: "End-to-end chat implementation: server endpoint with chat() and toServerSentEventsResponse(), client-side useChat hook with fetchServerSentEvents(), message rendering with UIMessage parts, multimodal content, thinking/reasoning display. Covers streaming states, connection adapters, and message format conversions. NOT Vercel AI SDK — uses chat() not streamText()."
- id: "@tanstack/ai#ai-core/client-persistence"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/client-persistence"
  for: "Browser chat persistence on useChat / ChatClient: localStoragePersistence, sessionStoragePersistence, indexedDBPersistence. Client-authoritative (adapter, full transcript) vs server-authoritative (persistence: true, no client cache). Reload restore, pending interrupts, mid-stream rejoin with delivery durability. Use for SPA reload durability — NOT server history alone. Also covers generation hooks (useGenerateImage etc.), which take only the server-driven mode: persistence: true hydrates the last generation for the (REQUIRED) threadId from the server on mount and repaints status/result/error, nothing is cached in the browser. No extra package: the adapters ship in the framework packages."
- id: "@tanstack/ai#ai-core/custom-backend-integration"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/custom-backend-integration"
  for: "Connect useChat to a non-TanStack-AI backend through custom connection adapters. ConnectConnectionAdapter (single async iterable) vs SubscribeConnectionAdapter (separate subscribe/send). Customize fetchServerSentEvents() and fetchHttpStream() with auth headers, custom URLs, and request options. Import from framework package, not @tanstack/ai-client."
- id: "@tanstack/ai#ai-core/debug-logging"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/debug-logging"
  for: "Pluggable, category-toggleable debug logging for TanStack AI activities. Toggle with `debug: true | false | DebugConfig` on chat(), summarize(), generateImage(), generateSpeech(), generateTranscription(), generateVideo(). Categories: request, provider, output, middleware, tools, agentLoop, config, errors. Pipe into pino/winston/etc via `debug: { logger }`. Errors log by default even when `debug` is omitted; silence with `debug: false`."
- id: "@tanstack/ai#ai-core/locks"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/locks"
  for: "LockStore, InMemoryLockStore, LocksCapability and withLocks for multi-instance coordination in TanStack AI. Ships in @tanstack/ai — NOT in @tanstack/ai-persistence. Separate from AIPersistence state stores — not a stores key, not composable. InMemoryLockStore vs a distributed (e.g. Cloudflare Durable Object) lock, lease recovery, AbortSignal in critical sections. Use when sandbox or other middleware needs cross-worker mutual exclusion — NOT for storing messages/runs (use withPersistence)."
- id: "@tanstack/ai#ai-core/media-generation"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/media-generation"
  for: "Image, audio, video, speech (TTS), and transcription generation using activity-specific adapters: generateImage() with openaiImage/geminiImage/byteplusImage, generateAudio() with geminiAudio/falAudio, generateVideo() with async polling (openaiVideo/geminiVideo/grokVideo/falVideo/byteplusVideo/openRouterVideo, per-model typed durations), generateSpeech() with openaiSpeech/byteplusSpeech/elevenlabsSpeech, generateTranscription() with openaiTranscription/byteplusTranscription, generateVoice() with elevenlabsVoiceDesign (create a voice, then speak with it). React hooks: useGenerateImage, useGenerateAudio, useGenerateSpeech, useTranscription, useGenerateVideo. TanStack Start server function integration with toServerSentEventsResponse."
- id: "@tanstack/ai#ai-core/middleware"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/middleware"
  for: "Chat lifecycle middleware hooks: onConfig, onStart, onChunk, onBeforeToolCall, onAfterToolCall, onUsage, onFinish, onAbort, onError. Use for analytics, event firing, tool caching (toolCacheMiddleware), logging, and tracing. Middleware array in chat() config, left-to-right execution order. NOT onEnd/onFinish callbacks on chat() — use middleware."
- id: "@tanstack/ai#ai-core/structured-outputs"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/structured-outputs"
  for: "Type-safe JSON schema responses from LLMs using outputSchema on chat() and useChat(). Supports Zod, ArkType, and Valibot schemas. The adapter handles provider-specific strategies transparently — never configure structured output at the provider level. Pass stream:true alongside outputSchema for incremental JSON deltas + a completed typed object via the `structured-output.complete` event. Each successfully completed structured-output run adds a typed `StructuredOutputPart` to message history. partial/final derive from the most recent structured-output part after the latest user message. convertSchemaToJsonSchema() for manual schema conversion."
- id: "@tanstack/ai#ai-core/tool-calling"
  run: "npm exec --no -- intent load @tanstack/ai#ai-core/tool-calling"
  for: "Isomorphic tool system: toolDefinition() with Zod schemas, .server() and .client() implementations, passing tools to both chat() on server and useChat/clientTools on client, tool approval flows with needsApproval and bound interrupts (resolveInterrupt), generic middleware interrupts with defineInterrupt(), lazy tool discovery with lazy:true, rendering ToolCallPart and ToolResultPart in UI."
- id: "@tanstack/db#db-core"
  run: "npm exec --no -- intent load @tanstack/db#db-core"
  for: "TanStack DB core concepts: createCollection with queryCollectionOptions, electricCollectionOptions, powerSyncCollectionOptions, rxdbCollectionOptions, trailBaseCollectionOptions, localOnlyCollectionOptions. Live queries via query builder (from, where, join, select, groupBy, orderBy, limit). Optimistic mutations with draft proxy (collection.insert, collection.update, collection.delete). createOptimisticAction, createTransaction, createPacedMutations. Entry point for all TanStack DB skills."
- id: "@tanstack/db#db-core/collection-setup"
  run: "npm exec --no -- intent load @tanstack/db#db-core/collection-setup"
  for: "Creating typed collections with createCollection. Adapter selection: queryCollectionOptions (REST/TanStack Query), electricCollectionOptions (ElectricSQL real-time sync), powerSyncCollectionOptions (PowerSync SQLite), rxdbCollectionOptions (RxDB), trailBaseCollectionOptions (TrailBase), localOnlyCollectionOptions, localStorageCollectionOptions. CollectionConfig options: getKey, schema, sync, gcTime, autoIndex (default off), defaultIndexType, syncMode (eager/on-demand, plus progressive for Electric). StandardSchema validation with Zod/Valibot/ArkType. Collection lifecycle (idle/loading/ready/error). Adapter-specific sync patterns including Electric txid tracking, Query direct writes, Query initial data and scoped factories, and PowerSync query-driven sync with onLoad/onLoadSubset hooks."
- id: "@tanstack/db#db-core/custom-adapter"
  run: "npm exec --no -- intent load @tanstack/db#db-core/custom-adapter"
  for: "Building custom collection adapters for new backends. SyncConfig interface: sync function receiving begin, write, commit, markReady, markError, truncate, metadata primitives and returning cleanup, loadSubset, and optional unloadSubset handlers. ChangeMessage format (insert, update, delete). On-demand LoadSubsetOptions (where, orderBy, limit, offset, cursor). Expression parsing: parseWhereExpression, parseOrderByExpression, extractSimpleComparisons, parseLoadSubsetOptions. Collection options creator pattern. rowUpdateMode (partial vs full). Sync run, subscription lifecycle, and cleanup functions. Persisted sync metadata API (metadata.row and metadata.collection) for storing per-row and per-collection adapter state."
- id: "@tanstack/db#db-core/live-queries"
  run: "npm exec --no -- intent load @tanstack/db#db-core/live-queries"
  for: "Query builder fluent API: from, where, join, leftJoin, rightJoin, innerJoin, fullJoin, select, fn.select, groupBy, having, orderBy, limit, offset, distinct, findOne. Operators: eq, gt, gte, lt, lte, like, ilike, inArray, isNull, isUndefined, and, or, not. Aggregates: count, sum, avg, min, max. String functions: upper, lower, length, concat. Utility: coalesce, caseWhen. Math: add, subtract, multiply, divide. $selected namespace. createLiveQueryCollection. Derived collections. Predicate push-down. Incremental view maintenance via differential dataflow (d2ts). Virtual properties ($hasPendingWrites, $origin, $key, $collectionId). Includes subqueries for hierarchical data. Collection, toArray, materialize, and concat(toArray(...)) include modes. queryOnce for one-shot queries. createEffect for reactive side effects (onEnter, onUpdate, onExit, onBatch)."
- id: "@tanstack/db#db-core/mutations-optimistic"
  run: "npm exec --no -- intent load @tanstack/db#db-core/mutations-optimistic"
  for: "collection.insert, collection.update (Immer-style draft proxy), collection.delete. createOptimisticAction (onMutate + mutationFn). createPacedMutations with debounceStrategy, throttleStrategy, queueStrategy. createTransaction, getActiveTransaction, ambient transaction context. Transaction lifecycle (pending/persisting/completed/failed). Mutation merging. onInsert/onUpdate/onDelete handlers. PendingMutation type. Transaction.isPersisted."
- id: "@tanstack/db#db-core/persistence"
  run: "npm exec --no -- intent load @tanstack/db#db-core/persistence"
  for: "SQLite-backed persistence for TanStack DB collections. persistedCollectionOptions wraps any adapter (Electric, Query, PowerSync, or local-only) with durable local storage. Platform adapters: browser (WA-SQLite OPFS), React Native (op-sqlite), Expo (expo-sqlite), Electron (IPC), Node (better-sqlite3), Capacitor, Tauri, Cloudflare Durable Objects. Multi-tab/multi-process coordination via BrowserCollectionCoordinator / ElectronCollectionCoordinator / SingleProcessCoordinator. schemaVersion for migration resets. Local-only mode for offline-first without a server. Applied transaction log pruning and safe full-reload recovery."
- id: "@tanstack/db#meta-framework"
  run: "npm exec --no -- intent load @tanstack/db#meta-framework"
  for: "Integrating TanStack DB with meta-frameworks (TanStack Start, Next.js, Remix, Nuxt, SvelteKit). Client-side only: SSR is NOT supported — routes must disable SSR. Preloading eager collections in route loaders with collection.preload(). On-demand Query Collections require preloading the live query because source collection preload is a no-op. Multiple collection preloading with Promise.all. Framework-specific loader APIs."
- id: "@tanstack/devtools#devtools-app-setup"
  run: "npm exec --no -- intent load @tanstack/devtools#devtools-app-setup"
  for: "Install TanStack Devtools, pick framework adapter (React/Vue/Solid/Preact), register plugins via plugins prop, configure shell (position, hotkeys, theme, hideUntilHover, requireUrlFlag, eventBusConfig). TanStackDevtools component, defaultOpen, localStorage persistence."
- id: "@tanstack/devtools#devtools-marketplace"
  run: "npm exec --no -- intent load @tanstack/devtools#devtools-marketplace"
  for: "Publish plugin to npm and submit to TanStack Devtools Marketplace. PluginMetadata registry format, plugin-registry.ts, pluginImport (importName, type), requires (packageName, minVersion), framework tagging, multi-framework submissions, featured plugins."
- id: "@tanstack/devtools#devtools-plugin-panel"
  run: "npm exec --no -- intent load @tanstack/devtools#devtools-plugin-panel"
  for: "Build devtools panel components that display emitted event data. Listen via EventClient.on(), handle theme (light/dark), use @tanstack/devtools-ui components. Plugin registration (name, render, id, defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins. Two paths: Solid.js core with devtools-ui for multi-framework support, or framework-specific panels."
- id: "@tanstack/devtools#devtools-production"
  run: "npm exec --no -- intent load @tanstack/devtools#devtools-production"
  for: "Handle devtools in production vs development. removeDevtoolsOnBuild, devDependency vs regular dependency, conditional imports, NoOp plugin variants for tree-shaking, non-Vite production exclusion patterns."
- id: "@tanstack/devtools-event-client#devtools-bidirectional"
  run: "npm exec --no -- intent load @tanstack/devtools-event-client#devtools-bidirectional"
  for: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
- id: "@tanstack/devtools-event-client#devtools-event-client"
  run: "npm exec --no -- intent load @tanstack/devtools-event-client#devtools-event-client"
  for: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
- id: "@tanstack/devtools-event-client#devtools-instrumentation"
  run: "npm exec --no -- intent load @tanstack/devtools-event-client#devtools-instrumentation"
  for: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
- id: "@tanstack/devtools-vite#devtools-vite-plugin"
  run: "npm exec --no -- intent load @tanstack/devtools-vite#devtools-vite-plugin"
  for: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
- id: "@tanstack/markdown#custom-extensions"
  run: "npm exec --no -- intent load @tanstack/markdown#custom-extensions"
  for: "Implement MarkdownExtension block parsers, inline and document transforms, HTML hooks, and portable ComponentNode output. Load when adding deterministic custom syntax or rendering behavior across HTML, React, and Octane."
- id: "@tanstack/markdown#docs-features"
  run: "npm exec --no -- intent load @tanstack/markdown#docs-features"
  for: "Build documentation metadata with docsMarkdownExtensions, GitHub-style callouts, heading collection, comment components, heading/file/package- manager/bundler tabs, framework panels, and code-fence metadata. Load when authoring or consuming TanStack-style docs syntax and custom-element data contracts."
- id: "@tanstack/markdown#octane-rendering"
  run: "npm exec --no -- intent load @tanstack/markdown#octane-rendering"
  for: "Render Markdown source or a MarkdownDocument with @tanstack/markdown/octane using Markdown, renderMarkdownOctane, ComponentBody replacements, TSRX, and octane/server static SSR. Load for Octane descriptors, custom emitted tags, pre-parsed documents, SSR return values, or renderer parity."
- id: "@tanstack/markdown#production-pipelines"
  run: "npm exec --no -- intent load @tanstack/markdown#production-pipelines"
  for: "Audit and ship a production Markdown pipeline with explicit trust boundaries, external syntax highlighting, parse-ahead caching, compatibility checks, deterministic output, and bundle budgets. Load before deploying blogs, docs, or untrusted-content rendering."
- id: "@tanstack/markdown#react-rendering"
  run: "npm exec --no -- intent load @tanstack/markdown#react-rendering"
  for: "Render Markdown source or a MarkdownDocument with @tanstack/markdown/react using Markdown, renderMarkdownReact, component replacements, and React static SSR. Load for React article components, emitted-tag mappings, pre-parsed documents, custom elements, or renderer parity."
- id: "@tanstack/markdown#render-markdown"
  run: "npm exec --no -- intent load @tanstack/markdown#render-markdown"
  for: "Parse Markdown with parseMarkdown or parseInline, render HTML with renderHtml, renderDocument, renderBlock, or renderInline, configure frontmatter and heading IDs, and reuse the serializable MarkdownDocument AST. Load for @tanstack/markdown core syntax, parser options, HTML output, references, footnotes, lists, tables, or AST work."
- id: "@tanstack/match-sorter-utils#fuzzy-ranking"
  run: "npm exec --no -- intent load @tanstack/match-sorter-utils#fuzzy-ranking"
  for: "Rank fuzzy matches with rankItem, filter with RankingInfo.passed, compare saved ranking metadata with compareItems, and configure rankings, thresholds, accessors, min/max bounds, or diacritics. Load for @tanstack/match-sorter-utils itself or fuzzy Table filterMeta wiring."
- id: "@tanstack/react-db#react-db"
  run: "npm exec --no -- intent load @tanstack/react-db#react-db"
  for: "React bindings for TanStack DB. Prefer useLiveQuery({ query }) with derived structured query identity. Provide queryKey only for opaque functional query variants or very hot render paths. Dependency arrays are legacy and warn before 1.0 removal. useLiveSuspenseQuery for React Suspense with Error Boundaries (data always defined). useLiveInfiniteQuery for cursor-based pagination (pageSize, fetchNextPage, hasNextPage, isFetchingNextPage). usePacedMutations for debounced React state updates. Return shape: data, state, collection, status, isLoading, isReady, isError. Import from @tanstack/react-db (re-exports all of @tanstack/db)."
- id: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
  run: "npm exec --no -- intent load @tanstack/react-start#lifecycle/migrate-from-nextjs"
  for: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
- id: "@tanstack/react-start#react-start"
  run: "npm exec --no -- intent load @tanstack/react-start#react-start"
  for: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
- id: "@tanstack/react-start#react-start/server-components"
  run: "npm exec --no -- intent load @tanstack/react-start#react-start/server-components"
  for: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
- id: "@tanstack/react-table#getting-started"
  run: "npm exec --no -- intent load @tanstack/react-table#getting-started"
  for: "Create and render Table v9 with the react adapter. Route reusable createTableHook components, Query and Virtual integration, and framework setup; use table-state for reactive ownership."
- id: "@tanstack/react-table#migrate-v8-to-v9"
  run: "npm exec --no -- intent load @tanstack/react-table#migrate-v8-to-v9"
  for: "Migrate react Table v8 to v9. Audit framework construction, rendering, state, and app hooks, with shared API changes in the core migration skill."
- id: "@tanstack/react-table#table-state"
  run: "npm exec --no -- intent load @tanstack/react-table#table-state"
  for: "Read and control Table v9 state in react. Use for tracked reads, subscriptions, controlled slices, and framework-specific reactive boundaries."
- id: "@tanstack/router-core#router-core"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core"
  for: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
- id: "@tanstack/router-core#router-core/auth-and-guards"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/auth-and-guards"
  for: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
- id: "@tanstack/router-core#router-core/code-splitting"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/code-splitting"
  for: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
- id: "@tanstack/router-core#router-core/data-loading"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/data-loading"
  for: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
- id: "@tanstack/router-core#router-core/navigation"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/navigation"
  for: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
- id: "@tanstack/router-core#router-core/not-found-and-errors"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/not-found-and-errors"
  for: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
- id: "@tanstack/router-core#router-core/path-params"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/path-params"
  for: "Dynamic path segments ($paramName), splat routes ($ / _splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
- id: "@tanstack/router-core#router-core/search-params"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/search-params"
  for: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
- id: "@tanstack/router-core#router-core/ssr"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/ssr"
  for: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
- id: "@tanstack/router-core#router-core/type-safety"
  run: "npm exec --no -- intent load @tanstack/router-core#router-core/type-safety"
  for: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
- id: "@tanstack/router-plugin#router-plugin"
  run: "npm exec --no -- intent load @tanstack/router-plugin#router-plugin"
  for: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
- id: "@tanstack/start-client-core#start-core"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core"
  for: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
- id: "@tanstack/start-client-core#start-core/auth-server-primitives"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/auth-server-primitives"
  for: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, __Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
- id: "@tanstack/start-client-core#start-core/deployment"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/deployment"
  for: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
- id: "@tanstack/start-client-core#start-core/execution-model"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/execution-model"
  for: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE_ prefix, process.env)."
- id: "@tanstack/start-client-core#start-core/middleware"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/middleware"
  for: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
- id: "@tanstack/start-client-core#start-core/server-functions"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/server-functions"
  for: "createServerFn (GET/POST), validator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
- id: "@tanstack/start-client-core#start-core/server-routes"
  run: "npm exec --no -- intent load @tanstack/start-client-core#start-core/server-routes"
  for: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
- id: "@tanstack/start-server-core#start-server-core"
  run: "npm exec --no -- intent load @tanstack/start-server-core#start-server-core"
  for: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
- id: "@tanstack/table-core#core"
  run: "npm exec --no -- intent load @tanstack/table-core#core"
  for: "Use TanStack Table v9 core architecture, stable data and columns, and inferred types. Route setup, missing APIs, row models, state, features, and framework-specific work."
- id: "@tanstack/table-core#custom-features"
  run: "npm exec --no -- intent load @tanstack/table-core#custom-features"
  for: "Implement a Table v9 plugin when built-ins and typed meta are insufficient. Covers FeatureMaps, runtime lifecycle hooks, prototypes, and a complete checked example."
- id: "@tanstack/table-core#migrate-v8-to-v9"
  run: "npm exec --no -- intent load @tanstack/table-core#migrate-v8-to-v9"
  for: "Audit and migrate Table v8 to v9. Inventory affected APIs, follow the shared checklist, and read only the required architecture, state, feature, and TypeScript mappings."
- id: "@tanstack/table-core#table-features"
  run: "npm exec --no -- intent load @tanstack/table-core#table-features"
  for: "Add or debug Table v9 features: registration, row-model slots, prerequisites, sorting, filtering, pagination, selection, spanning, and column layout. Read only task-relevant feature references."
- id: "@tanstack/table-core#table-state"
  run: "npm exec --no -- intent load @tanstack/table-core#table-state"
  for: "Choose Table v9 state ownership, atoms, initialization, updates, and resets. Load for controlled slices or state coordination; use the adapter state skill for reactive reads."
- id: "@tanstack/virtual-file-routes#virtual-file-routes"
  run: "npm exec --no -- intent load @tanstack/virtual-file-routes#virtual-file-routes"
  for: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
- id: "dotenv#dotenv"
  run: "npm exec --no -- intent load dotenv#dotenv"
  for: "Load environment variables from a .env file into process.env for Node.js applications. Use when configuring apps with secrets, setting up local development environments, managing API keys and database uRLs, parsing .env file contents, or populating environment variables programmatically. Always use this skill when the user mentions .env, even for simple tasks like \"set up dotenv\" — the skill contains critical gotchas (encrypted keys, variable expansion, command substitution) that prevent common production issues."
- id: "dotenv#dotenvx"
  run: "npm exec --no -- intent load dotenv#dotenvx"
  for: "Use dotenvx to run commands with environment variables, manage multiple .env files, expand variables, and encrypt env files for safe commits and CI/CD."

<!-- intent-skills:end -->

# MediFlow — project context for agents

Hospital management demo (patients, appointments, lab records, AI assistant) that
demonstrates the TanStack ecosystem end to end. **Sample data only — not for
clinical use.**

## How the project was created

TanStack CLI scaffold (run in a scratch dir, then merged into this repo). The
request text contained a full-width `＠`; the real `@` was used:

```bash
npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager npm --tailwind --toolchain eslint --add-ons ai,shadcn,store,prisma,tanstack-query,table,form
```

Follow-up TanStack Intent commands:

```bash
npx @tanstack/intent@latest install   # needs an interactive terminal; the scaffold's run failed non-interactively
npx @tanstack/intent@latest install --map   # what was actually run -> wrote the intent-skills block at the top of this file
npx @tanstack/intent@latest list
npm exec --no -- intent load <package>#<skill>   # load a skill before changing library-specific code
```

`@tanstack/intent` is also a devDependency so `npm exec --no -- intent …` works.
Re-run `intent install --map` after adding/upgrading TanStack packages.

Extra libraries not covered by the CLI add-ons were installed with npm:
`@tanstack/react-db`, `@tanstack/query-db-collection`, `@tanstack/react-hotkeys`,
`@tanstack/react-pacer`, `@tanstack/react-virtual`.

## Stack & where each TanStack library is demonstrated

| Library      | Where                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Start        | SSR app, server functions `src/server/hospital.functions.ts`, server route `src/routes/demo/api.ai.chat.ts`                         |
| Router       | file routes in `src/routes`, loaders + `ensureQueryData`, zod-validated search params on `/patients`                                |
| Query        | all server state; keys/options in `src/lib/hospital/queries.ts`; SSR integration in `src/router.tsx`                                |
| Table (v9)   | `/patients` (`src/routes/patients/index.tsx`) — sorting, global/column filter, pagination                                           |
| Form         | `/patients/new`, booking form on `/appointments`; app form hook `src/hooks/demo.form.ts`                                            |
| Store        | `src/lib/hospital/ui-store.ts` (density, shortcuts dialog); AI panel toggle                                                         |
| DB           | `/appointments` — `src/lib/hospital/collections.ts` (Query collections, live 3-way join, optimistic updates), route is `ssr: false` |
| AI           | header assistant + `/demo/ai-chat`; tools in `src/lib/hospital-ai-tools.ts` (defs) and `api.ai.chat.ts` (server impls)              |
| Hotkeys      | `src/components/GlobalHotkeys.tsx` (G-sequences, `?`, `Shift+D`), `/` and `N` on `/patients`, `Mod+Enter` in forms                  |
| Pacer        | `useDebouncedValue` for search on `/patients` and `/records`                                                                        |
| Virtual      | `/records` — 25,000 generated lab results windowed with `useVirtualizer`                                                            |
| CLI / Intent | scaffold (`.cta.json`) and the skill mappings in this file                                                                          |

Other: React 19, Tailwind 4, shadcn-style UI primitives in `src/components/ui`, ESLint (`@tanstack/eslint-config`) + Prettier, Prisma 7 (PostgreSQL), zod 4, npm.

## Environment variables (see `.env.example`; put real values in `.env.local`, which is git-ignored)

- `HOSPITAL_STORAGE` — `memory` (default; seeded in-process data, no DB) or `prisma`.
- `DATABASE_URL` — PostgreSQL URL; required for `prisma` mode and all `db:*` scripts.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` — chat provider, first set wins in that order; none → local Ollama (`OLLAMA_HOST`). `OPENAI_API_KEY` is also needed for the image, TTS and transcription demos.

## Commands

```bash
npm install
npm run dev            # http://localhost:3000
npm run build
npx tsc --noEmit       # typecheck
npm run lint           # eslint (toolchain)
npm run check          # prettier --check
# Postgres mode:
npm run db:generate && npm run db:push && npm run db:seed   # then HOSPITAL_STORAGE=prisma
```

`src/generated/prisma` is generated (git-ignored) — run `npm run db:generate` after a fresh clone and after schema edits.

## Key architectural decisions

- **Dual storage**: `src/server/hospital-repo.server.ts` exposes one `HospitalRepo` interface with in-memory and Prisma implementations, so the demo runs with zero infrastructure. Data crosses the wire as DTOs with ISO date strings (`src/lib/hospital/schemas.ts`).
- **One zod schema, both sides**: form validators and server-function validators share `patientInputSchema` / `appointmentInputSchema`.
- **TanStack DB is client-only**: collections are created lazily per `QueryClient` and only used in the `ssr: false` appointments route (per the shipped `db` meta-framework skill).
- **Table v9 stable inputs**: `features`, `columns` and memoised state objects must be referentially stable — an inline `columnFilters` array caused the page index to reset on every render (fixed).
- Scaffold demos are kept under `src/routes/demo` (store, query, forms, prisma todos, AI image/structured/TTS). The guitar-shop demo and the v8-style table demo were removed/replaced by the hospital equivalents.

## Patient care workflow

State machine in `src/lib/hospital/workflow.ts` (pure; shared by UI and server):
`REGISTERED → TRIAGE → ADMITTED → TREATMENT → READY_FOR_DISCHARGE → DISCHARGED`
(extra edges: `TRIAGE → DISCHARGED` for treat-and-release, `READY_FOR_DISCHARGE → TREATMENT` for relapse; `DISCHARGED` is terminal).

- Guards: leaving TRIAGE needs ≥1 vitals reading; entering DISCHARGED needs a `DISCHARGE` clinical note.
- Enforcement lives in the service functions at the bottom of `src/server/hospital-repo.server.ts` (`transitionPatient`, `setPatientStatus`, `setAppointmentStatus`); both storage backends only persist (`applyTransition` writes the stage, the coarse `status`, and a history event). The UI calls `checkTransition` to disable blocked buttons and show why.
- `stage` (where the patient is in care) is separate from `status` (acuity/disposition: ADMITTED/OUTPATIENT/CRITICAL/DISCHARGED). `statusAfter()` keeps them consistent; `DISCHARGED` status can only be reached via the workflow.
- Checking in an appointment moves a `REGISTERED` patient to `TRIAGE`.
- Chart (`/patients/$patientId`) shows stepper + allowed moves, vitals form, clinical notes, history timeline, appointments, and (generated, demo-only) lab results. Data: `StageEvent`, `ClinicalNote`, `VitalsReading` (Prisma models + in-memory arrays).
- Actor is the placeholder `demo-user` until auth exists; history is not tamper-proof.

## Known gotchas

- **No authentication/authorization.** Server functions and `/demo/api/ai/chat` are public HTTP endpoints that expose patient data. Add auth middleware (see the `start-core/auth-server-primitives` skill) and audit logging before any real use; the AI route should also be authenticated and rate-limited.
- Prisma mode was type-checked and the client generated, but **not exercised against a live Postgres** in the build environment (none available). Run `db:push` + `db:seed` and smoke test before relying on it.
- `shadcn add` could not reach `ui.shadcn.com` during scaffolding, so `src/components/ui/*` (button, input, textarea, label, select, badge, card) are hand-written in shadcn style; `select` is a native `<select>`. Slider/switch were not generated (unused). Retry `npx shadcn@latest add …` when online if you want the Radix versions.
- Hotkeys: `?` is registered as `Shift+/`. Single-key hotkeys ignore events from inputs by default; `Mod+…` combos do not.
- `createServerFn().validator()` is the current API in this Start version (`inputValidator` logs a deprecation warning).
- With no AI key set the chat falls back to Ollama and returns a 500 if it is not running.
- `npm audit` reports advisories in transitive scaffold dependencies; review before deploying.

## Deployment notes

`npm run build` outputs `dist/` (Vite/Nitro-style server bundle at `dist/server/server.js`). Choose a hosting target adapter before production (Node, Netlify, Cloudflare, etc. — see TanStack Start hosting docs), provide the env vars above, run `prisma migrate deploy` (or `db push`) against the production database and set `HOSPITAL_STORAGE=prisma`.

## Next steps

1. Authentication + role-based access (doctor / nurse / admin) and audit trail.
2. Replace `db push` with checked-in Prisma migrations; seed via `db:seed`.
3. Server-side pagination for `/patients` once data outgrows the client (Table `manualPagination` + Query).
4. Persist lab records in the DB and virtualise with `useLiveInfiniteQuery`.
5. Add tests (Vitest for the repo/schemas/workflow rules, Playwright for the chart flow). The workflow rules were verified with an ad-hoc tsx script and a Playwright walkthrough, but no automated tests are committed.
6. Real per-patient lab orders/results (chart labs are generated), medication orders, bed management, and role-based permissions on transitions.
