Release 2.2.20

This release improves the rendering of suggested follow-up question URLs to be more user-friendly and support both markdown links and plain-text URL formats.

Changes:
- Added plain-text URL detection: URLs like `https://chat.virtualflybrain.org?query=...` are now automatically converted to clickable links
- Extract preceding text as link label: when text precedes the URL (e.g., `What is the medulla https://...`), the question text becomes the link label for cleaner UX
- Fallback to decoded query text: if no preceding text is found, the URL-decoded query text is used as the link label
- Improved system prompt guidance with multiple example formats showing real-world usage patterns
- Emphasizes URL-encoding requirements and suggests varying question types for better follow-up quality
- Both plain-text URLs and markdown links are now properly rendered and clickable

Release 2.2.19

This release improves suggested follow-up questions by having the LLM natively include them as clickable query URLs in its markdown responses, rather than relying on client-side extraction.

Changes:
- System prompt now instructs gpt-5-nano to suggest follow-up questions as markdown links with `https://chat.virtualflybrain.org?query=` URLs
- renderLink function detects these special query URLs and handles clicks by submitting the question as a new chat message
- Eliminates false positive detection of regular content as suggested questions (fragile pattern matching removed)
- LLM has full control over suggestion placement (inline, bullets, sentences) and can omit suggestions when not appropriate
- More reliable than client-side extraction since LLM explicitly marks suggestions with URLs rather than relying on pattern matching

Release 2.2.18

This release adds intelligent extraction and rendering of suggested follow-up questions from gpt-5-nano responses, enabling users to quickly explore related topics with a single click.

Changes:
- Extracts follow-up question suggestions from gpt-5-nano responses using pattern recognition
- Renders suggested questions as shareable hyperlinks with query string URLs (https://chat.virtualflybrain.org?query=...)
- Auto-submits suggested questions when clicked, enabling seamless exploration flow
- Supports multiple intro phrase variations and list formats for robust extraction
- Filters suggestions to ensure quality and relevance (5-200 character range, max 5 suggestions)
- Questions removed from message content and shown as clickable links below response
- Hover effects highlight suggested links for better UX
- Links can be copied and shared directly with full query context

Release 2.2.17

This release fixes dataset search filtering to properly return only actual datasets instead of unrelated items like individual neurons or interfaces.

Changes:
- Fixed case sensitivity issue in VFB search filters (corrected "dataset" to "DataSet" to match VFB facet naming)
- Added client-side filtering as safety net to ensure only items with required facets are returned
- Updated search_terms tool description to include dataset filtering examples, guiding LLM to use proper filters
- Dataset searches now correctly exclude non-dataset items, returning only actual datasets like "FlyWire connectome neurons"
- Improved search accuracy for dataset queries, preventing confusion between datasets and individual data items

Release 2.2.16

This release fixes a critical runtime error that was preventing the chat API from functioning, ensuring the application works properly after the pre-fetching refactoring.

Changes:
- Fixed 'conversationMessages is not defined' runtime error in chat API route
- Added proper initialization of conversationMessages array with system prompt, message history, and resolved user message
- Ensures proper message flow for LLM API calls with MCP tool integration
- Application now functions correctly without crashing on chat requests

Release 2.2.15

This release fixes a critical runtime error that was preventing the chat API from functioning, and adds configurable timeouts to prevent MCP server timeouts for complex anatomical queries.

Changes:
- Fixed 'conversationMessages is not defined' runtime error in chat API route
- Added proper initialization of conversationMessages array with system prompt, message history, and resolved user message
- Ensures proper message flow for LLM API calls with MCP tool integration
- Added configurable timeout wrapper for MCP tool calls (30s for regular calls, 15s for pre-fetching, 60s for cache loading)
- Prevents indefinite hangs when MCP server takes too long to respond to complex queries (e.g., mushroom body structures)
- Application now handles MCP timeouts gracefully instead of crashing
- Improved reliability for queries about complex anatomical terms that require longer processing time

Release 2.2.15

This release fixes critical issues with complex anatomical term information retrieval by removing problematic pre-fetching logic that caused timeouts for terms like mushroom body, and ensures the LLM properly fetches detailed information during conversations.

Changes:
- Removed pre-fetching of term information that was causing timeouts for complex anatomical structures (mushroom body, etc.)
- Updated system prompt strategy to instruct LLM to call get_term_info during conversation when encountering VFB term IDs
- Eliminated dependency on pre-fetching that prevented access to detailed information for complex terms
- Fixed JavaScript syntax issues from refactoring
- Now ensures complete and accurate responses for all anatomical terms, even if they take longer to fetch
- Improved reliability for queries about complex brain regions with extensive metadata

Release 2.2.14

This release implements VFB_connect-style lookup methodology, fixes anatomical term mappings, and enhances fuzzy matching for improved AI accuracy in Drosophila neuroanatomy identification.

Changes:
- Implemented VFB_connect-style lookup system with database-driven loading from VFB MCP server
- Fixed MCP tool calls in loadVfbLookupTable function to use correct tool names (mcp_virtual-fly-b_search_terms)
- Corrected anatomical term mappings that were causing AI confusion between brain regions (mushroom body, protocerebrum, deutocerebrum, etc.)
- Enhanced fuzzy matching with prefix substitutions for developmental stages (adult/larval/pupal/embryonic)
- Replaced hardcoded seed data with verified essential anatomical terms as fallback
- Improved term resolution with multiple matching strategies and normalized fuzzy matching
- Added comprehensive lookup cache with 2,500+ verified term mappings from VFB database
- Enhanced error handling for MCP connection failures with graceful fallback to essential terms

Release 2.2.13

This release adds a footer disclaimer for AI reliability warnings, enhances Google Analytics error handling, and includes additional citation fixes for improved user experience and data accuracy.

Changes:
- Added footer disclaimer at bottom of chat window warning about AI response reliability and data recording
- Enhanced Google Analytics tracking with better error logging and success confirmation
- Improved citation generation to prevent random DOI hallucination and ensure VFB data accuracy
- Added UI disclaimer about verifying information with primary sources and not sharing private data
- Updated README documentation to reflect UI disclaimer feature
- Enhanced system prompt restrictions for citation generation
- Improved user experience with clear privacy and reliability notices

Release 2.2.12

This release adds thumbnail URL validation to prevent display of broken images, fixes citation generation issues, and improves reliability of VFB data presentation.

Changes:
- Added async thumbnail URL validation using axios.head to check image existence before inclusion
- Modified summarizeTermInfo function to validate thumbnail URLs with 2-second timeout
- Updated system prompt to restrict citations to VFB data only - prevents LLM from generating random DOIs
- Enhanced publication extraction to include FBrf IDs from Synonyms field in addition to Publications field
- Prevents LLM from hallucinating invalid URLs like malformed template IDs (e.g., /VFB_001011rk/)
- Added error handling and logging for failed thumbnail validations
- Improved user experience by filtering out broken image links and irrelevant citations

Release 2.2.11

This release fixes a critical bug in tool call processing that was causing crashes when the LLM made MCP queries.

Changes:
- Fixed variable scoping bug where `parsedArgs` was referenced before declaration in tool call processing
- Resolved "parsedArgs is not defined" error that occurred during connectivity queries
- Improved stability of MCP tool call execution
- Enhanced error handling for tool argument parsing

Release 2.2.10

This release adds table rendering support for connectivity data and improves LLM understanding of neuron class vs individual connectivity queries.

Changes:
- Added table rendering components (table, thead, tbody, tr, th, td) to markdownComponents for proper display of connectivity data tables
- Enhanced system prompt with guidance for connectivity queries: when neuron classes lack connectivity data, look at individual neurons from connectomes
- Updated strategy section to explain using "ListAllAvailableImages" to find individual neurons, then checking for "NeuronNeuronConnectivityQuery" on those individuals
- Improved LLM understanding of VFB data hierarchy: classes vs individuals for connectivity analysis
- Better handling of large connectivity datasets with proper table formatting in chat interface

Release 2.2.9

This release optimizes VFB data queries and prevents LLM hallucinations when running analytical queries.

Changes:
- Optimized query strategy to avoid unnecessary get_term_info calls when displaying multiple neurons in VFB browser
- Enhanced logging to show "pulling info on [ID]" status messages for better user visibility
- Prevented hallucinated query types by requiring get_term_info before run_query calls
- Updated system prompt to only use valid query types from the Queries array returned by get_term_info
- Improved efficiency for bulk neuron display while maintaining accuracy for analytical queries
- Enhanced user experience with clearer status updates during data retrieval

Release 2.2.8

This release fixes incorrect linking of FlyBase reference IDs (FBrf) to point to FlyBase instead of Virtual Fly Brain.

Changes:
- Fixed FBrf ID links to route to FlyBase (https://flybase.org/reports/FBrfXXXXXXX) instead of VFB
- VFB and FBbt IDs continue to link to Virtual Fly Brain as appropriate
- Added distinct tooltips: 'View in FlyBase' vs 'View in VFB' for better user guidance
- Improved link routing logic to handle different ID types correctly
- Enhanced user experience when accessing publication references from VFB data

Release 2.2.7

This release fixes image clipping issues in the chat interface by improving how VFB thumbnail images are displayed.

Changes:
- Fixed image clipping by removing forced square aspect ratio (64x64px) for VFB thumbnails
- Changed thumbnail images to use maxHeight: 64px with auto width for proper aspect ratio
- Switched from objectFit: 'cover' to 'contain' to prevent image distortion
- Increased maxWidth to 120px to allow wider images while maintaining height limit
- Preserves image integrity for brain region anatomical images
- Improved visual quality of inline image thumbnails

Release 2.2.6

This release fixes a critical issue where the LLM was losing conversation context between messages, preventing proper follow-up responses.

Changes:
- Fixed conversation context loss by sending full chat history to API
- Updated frontend to include conversation history in API requests
- Modified backend to process conversation context in LLM prompts
- Maintains system instructions while preserving chat history
- Improved user experience for multi-turn conversations
- Enhanced LLM context awareness for related queries

This resolves the issue where asking "name a neuron in this region" after "medulla?" would result in the AI asking for clarification instead of remembering the medulla context.

Release 2.2.5

This release refines thumbnail image selection by using precise VFB data structure logic based on IsClass and has_image fields.

Changes:
- Implemented precise field selection: IsClass=true uses Examples, IsClass=false + has_image uses Images
- Updated summarizeTermInfo to check IsClass and SuperTypes for correct field selection
- Simplified visual data processing by using single visualData field based on entity type
- Enhanced system prompt with accurate VFB data structure explanation
- Improved LLM guidance for proper Images vs Examples field usage
- Added clearer distinction between "aligned images" (individuals) and "example images" (classes)

Release 2.2.4

This release improves thumbnail image selection by properly handling both individual neuron images and anatomical region examples, with intelligent template prioritization.

Changes:
- Added support for "Examples" field in addition to "Images" field from VFB API
- Anatomical regions (classes) use "Examples" while individual neurons use "Images"
- Implemented template prioritization: JRC2018Unisex → JFRC2 → Ito2014 → others
- Updated system prompt to explain the difference between Images and Examples
- Enhanced summarizeTermInfo function to handle both data types with proper prioritization
- Improved LLM guidance for selecting appropriate thumbnails based on entity type

Release 2.2.3

This release fixes a critical issue where the AI was generating fake thumbnail URLs instead of using actual URLs from VFB data.

Changes:
- Fixed AI hallucination of thumbnail URLs by updating system prompt to explicitly forbid making up URLs
- Enhanced DISPLAYING IMAGES instructions to only show thumbnails when actually available in VFB data
- Added strict warnings against inventing or modifying thumbnail URLs
- Improved LLM guidance to use exact URLs from get_term_info responses only

Release 2.2.2

This release improves paper citation formatting and fixes thumbnail URL generation issues.

Changes:
- Added CITATIONS section to system prompt with common Drosophila neuroscience paper links
- Updated FORMATTING instructions to include [citation](url) format for paper references
- Enhanced term info summarization to include publication data when available
- Added mappings for common citations like Ito et al., 2013 and Ito et al., 2014
- Improved LLM instructions for converting DOI and FBrf IDs into proper links
- Fixed thumbnail URL generation: AI now only shows actual thumbnail URLs from VFB data, never makes up URLs
- Updated DISPLAYING IMAGES instructions to be explicit about only using real URLs from get_term_info responses

Release 2.2.1

This release fixes a critical bug where thumbnail images were displaying placeholder URLs ("...") instead of actual image IDs, preventing proper visualization of VFB neuroscience images.

Changes:
- Fixed system prompt to correctly reference "Images" field instead of outdated "Examples" field
- Updated term info summarization to include actual thumbnail URLs from VFB API responses
- Enhanced pre-fetched term info to provide real image URLs to the LLM
- Improved LLM instructions for extracting and using thumbnail URLs from get_term_info responses
- Added detailed examples of VFB image URL structure in system prompt

Release 2.2.0

This release adds comprehensive usage monitoring and responsible AI usage guidelines to enhance user experience and system quality control.

Changes:
- Implemented Google Analytics tracking for user queries and AI responses
- Added tracking of query text (truncated), query length, response length, and processing duration
- Integrated axios for GA4 API communication
- Updated welcome message with AI usage guidelines and warnings
- Added comprehensive documentation about responsible AI use
- Included warnings about verifying AI responses and privacy considerations
- Enhanced user interface with clear guidelines for academic and research use

Release 2.1.1

This release adds comprehensive security features to protect against jailbreak attempts and enhance the safety of the VFB chat application.

Changes:
- Added advanced jailbreak detection to prevent attempts to bypass safety restrictions
- Implemented blocking of common jailbreak patterns including developer mode, uncensored personas, and system prompt manipulation
- Enhanced security logging for monitoring and analysis
- Updated documentation with security features section

Release 1.1.2

This release includes performance optimizations for the VFB chat application, including compressed system prompts to avoid token limits, improved term resolution caching, and fixes for JSON parsing of VFB MCP responses.

Changes:
- Compressed system prompt to under 4K tokens
- Fixed summarizeTermInfo function for accurate VFB data parsing
- Pre-fetched term information to reduce redundant API calls
- Improved response times and eliminated prompt truncation warnings