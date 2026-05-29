// Platform Information
const platform = {
    title: 'Instagram',
    regular_url: 'https://www.instagram.com',
    url: 'https://www.instagram.com/',
    icon: 'https://static.cdninstagram.com/rsrc.php/yn/r/Puw_9ASeZc1.webp',
    banner: 'https://raw.githubusercontent.com/b-risk/Grayjay-Instagram/main/Imgs/channel-banner.png',
    description: 'Instagram is a photo and video sharing social networking service owned by Meta Platforms.'
};

// Non-user paths
const EXCLUDED_USER_PATHS = [
    'reel', 
    'p', 
    'explore', 
    'accounts', 
    'direct', 
    'stories', 
    'saved', 
    'search', 
    'tags', 
    'about', 
    'legal', 
    'help', 
    'blog'
];

// Current list of Kittygram instances
const KITTYGRAM_INSTANCES = [
    'https://kittygram.irelephant.net',
    'https://kittygr.am',
    'https://kittygram.kareem.one',
    'https://kg.lus.lu',
    'https://kg.meowing.de',
    'https://kittygram.nexussfan.cz'
];

// State
let config = {};
let settings = {};
let videoUrlCache = {};      // shortcode → video URL (cached from feed API)
let feedItemCache = {};      // shortcode → feed item data (cached for reuse)
let thumbnailCache = {};     // shortcode → resolved thumbnail URL (from getChannelContents)
let likesCache = {};         // shortcode → like count (from channel feed cards)
let datetimeCache = {};      // shortcode → datetime (from channel feed cards)
let commentCache = {};       // shortcode → InstagramCommentPager (from comment fetches)
let pageHtmlCache = {};      // shortcode → raw Kittygram post page HTML (for comment reuse)

// Source enable
source.enable = function (conf, _settings) {
    config = conf;
    settings = _settings;
    log('Instagram plugin enabled, config id: ' + (config.id || 'none'));
}

// Returns the home feed (empty for logged-out Instagram)
source.getHome = function () {
    return new ContentPager([]);
}

// Returns the shorts/reels feed (empty for logged-out Instagram)
source.getShorts = function () {
    return new ContentPager([]);
}

// Returns search suggestions (unused)
source.searchSuggestions = function (query) {
    return [];
}

// Returns minimal search capabilities
source.getSearchCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
}

// Returns minimal search capabilities for channel contents
source.getSearchChannelContentsCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
}

// Search for videos/channels (returns empty, Kittygram has no video search endpoint)
source.search = function (query, type, order, filters, continuationToken) {
    return new VideoPager([], false);
}

// Search for content within a channel, filtered by query
source.searchChannelContents = function (url, query, type, order, filters, continuationToken) {
    if (!url || !query || query.length < 1) 
        return new VideoPager([], false);

    return getChannelContentPager(url, type, order, filters, continuationToken, query);
}

// Search for channels using Kittygram
source.searchChannels = function (query) {
    if (!query || query.length < 2) 
        return new ChannelPager([], false);
    
    return new ChannelPager(searchKittygramChannels(query), false);
}

// Get channel (user profile) details
source.getChannel = function (url) {
    const username = extractUsername(url);

    if (!username || EXCLUDED_USER_PATHS.includes(username))
        throw new ScriptException('Instagram channel not found');

    return getPlatformChannel(username);
}

// Get channel feed contents
source.getChannelContents = function (url, type, order, filters, continuationToken) {
    if (!extractUsername(url)) 
        return new VideoPager([], false);

    return getChannelContentPager(url, type, order, filters, continuationToken, null);
}

// Returns channel feed capabilities
source.getChannelCapabilities = function () {
    return {
        types: [Type.Feed.Shorts, Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
}

// Detect channel URL
source.isChannelUrl = function (url) {
    const segments = urlSegments(url);

    return segments && segments.length <= 1 && (segments.length === 0 || !EXCLUDED_USER_PATHS.includes(segments[0]));
}

// Detect video/reel URL
source.isContentDetailsUrl = function (stringUrl) {
    const segments = urlSegments(stringUrl);

    return segments && segments.length === 2 && (segments[0] === 'p' || segments[0] === 'reel');
}

// Get video details for Instagram reels
source.getContentDetails = function (stringUrl) {
    // Extract shortcode from URL
    const segments = urlSegments(stringUrl);
    if (!segments)
       throw new ScriptException('Invalid Instagram URL');

    const isReel = segments[0] === 'reel';
    let shortcode = isReel ? segments[1] : (segments[0] === 'p' ? segments[1] : null);
    if (!shortcode)
       throw new ScriptException('Invalid Instagram URL');

    // Return cached data if available
    const cachedVideoUrl = videoUrlCache[shortcode];
    if (cachedVideoUrl) {
        log('getContentDetails: using cached video URL for ' + shortcode);
        const cachedMeta = feedItemCache[shortcode] || {
            title: 'Instagram Post', description: '', thumbnail: '',
            authorName: 'Unknown', authorThumb: '', datetime: null,
            duration: null, videoUrl: null
        };
        cachedMeta.videoUrl = cachedVideoUrl;
        return getVideoDetails(cachedMeta, shortcode, stringUrl, '', null);
    }

    // Fetch fresh metadata from Kittygram
    const kgPost = fetchKittygramPostData(shortcode);
    if (!kgPost.videoUrl)
       throw new ScriptException('Video not found');

    return getVideoDetails({
        title: kgPost.caption ? kgPost.caption.substring(0, 100) : 'Instagram Post',
        description: kgPost.caption || '',
        thumbnail: kgPost.thumbnail || '',
        authorName: kgPost.author || 'Unknown',
        authorThumb: kgPost.authorThumb || '',
        datetime: kgPost.datetime,
        likes: kgPost.likes,
        duration: kgPost.duration,
        videoUrl: kgPost.videoUrl
    }, shortcode, stringUrl, kgPost.authorThumb || '', kgPost.likes);
}

// Get photo post details
source.getPost = function (stringUrl) {
    // Extract shortcode from URL and fetch post metadata via Kittygram
    const segments = urlSegments(stringUrl);
    if (!segments || segments.length < 2) 
        throw new ScriptException('Invalid Instagram post URL');

    const shortcode = segments[segments.length - 1];
    if (!shortcode) 
        throw new ScriptException('Invalid Instagram post URL');

    const post = fetchKittygramPostData(shortcode);
    const title = (post.caption || 'Instagram Post').substring(0, 100);
    const authorName = post.author || 'Unknown';
    // Only populate images[] for actual image posts (carousel or single image).
    // Reels/video posts should have images[] empty — thumbnail is set separately.
    const images = post.images && post.images.length > 0
        ? post.images
        : (!post.videoUrl && post.thumbnail ? [post.thumbnail] : []);

    return new PlatformPostDetails({
        id: new PlatformID(platform.title, shortcode, config.id),
        name: title,
        author: getAuthor(authorName, platform.url + encodeURIComponent(authorName) + '/', ''),
        datetime: post.datetime,
        url: stringUrl,
        description: post.caption || '',
        images: images,
        thumbnails: images.map(function(img) { return new Thumbnails([new Thumbnail(img, 0)]); }),
        textType: Type.Text.Raw,
        content: post.caption || ''
    });
}

// Get comments for a post
source.getComments = function (stringUrl) {
    // Extract shortcode from URL and fetch comments via Kittygram
    const segments = urlSegments(stringUrl);
    if (!segments || segments.length < 2) 
        return new InstagramCommentPager([], false);
    
    // Return post/reel shortcode
    return getCommentsPager(segments[segments.length - 1]);
}

// Playlists are not supported
source.isPlaylistUrl = function (stringUrl) {
    return false;
}

// Playlists are not supported
source.getPlaylist = function (stringUrl) {
    throw new ScriptException('Playlists are not supported');
}

// Returns empty pager
source.searchPlaylists = function (query, type, order, filters, continuationToken) {
    return new PlaylistPager([], false);
}

// Returns empty claim map
source.getChannelTemplateByClaimMap = function () {
    return {};
}


// Utility Functions

/**
 * Performs a Kittygram HTTP GET with standard headers.
 * @param {string} url - Full URL to fetch
 * @returns {Object|null} HTTP response object
 */
function httpGET(url) {
    return http.GET(url, { 'User-Agent': 'Mozilla/5.0', 'Sec-Fetch-Mode': 'navigate' }, false);
}

/**
 * Parses comments from Kittygram post page HTML.
 * @param {string} html - Post page HTML
 * @param {string} shortcode - Post shortcode
 * @param {number} videoDatetime - Video datetime (optional, defaults to 0)
 * @returns {Array} Array of PlatformComment
 */
function parseKittygramPostPageComments(html, shortcode, videoDatetime = 0) {
    const comments = [];

    try {
        const doc = domParser.parseFromString(html, 'text/html');
        const commentArticles = doc.querySelectorAll('.comments article');

        // Parse each comment article into a PlatformComment
        commentArticles.forEach(function(article, idx) {
            const header = article.querySelector('.user-info');
            const textEl = article.querySelector('p.comment-text');
            
            const avatarImg = header ? header.querySelector('img') : null;
            const authorLink = article.querySelector('a.username');

            if (authorLink && textEl) {
                const author = authorLink.textContent.trim();
                const text = textEl.textContent.trim();
                let avatar = platform.icon;

                // Decode Kittygram-proxied avatar URL if available
                if (avatarImg) {
                    const avatarSrc = avatarImg.getAttribute('src');
                    if (avatarSrc)
                       avatar = decodeKittygramProxy(avatarSrc);
                }

                if (author && text) {
                    comments.push(new PlatformComment({
                        // Unique ID: shortcode + "_c" + comment index (e.g. "ABC123_c0")
                        // Kittygram comments don't contain extra metadata like datetime, ratings, etc
                        id: new PlatformID(platform.title, shortcode + '_c' + idx, config.id),
                        author: getAuthor(author, platform.url + encodeURIComponent(author), avatar),
                        message: text
                    }));
                }
            }
        });
    } catch (e) {
        log('parseKittygramPostPageComments: error: ' + e);
    }

    return comments;
}

/**
 * Extracts the post datetime from a Kittygram post page DOM.
 * Tries <time> element, then text fallback.
 * @param {Document} postDoc - Parsed post page DOM
 * @returns {number} Unix timestamp in seconds, or 0 if not found
 */
function extractPostDatetime(postDoc) {
    const bodyText = postDoc.body ? postDoc.body.textContent : '';
    const timeEl = postDoc.querySelector('time.post-time');
    if (timeEl) {
        const dtAttr = timeEl.getAttribute('datetime');
        if (dtAttr) {
            const parsed = parseDatetimeToUnix(dtAttr);
            if (parsed)
               return parsed;
        }
    }

    const timeMatch = bodyText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    if (timeMatch) {
        const parsed2 = parseDatetimeToUnix(timeMatch[1] + ' ' + timeMatch[2]);
        if (parsed2)
           return parsed2;
    }

    return 0;
}

/**
 * Fetches comments for a post from Kittygram instances.
 * Tries each instance in order until comments are found.
 * @param {string} shortcode - Post/reel shortcode
 * @returns {InstagramCommentPager}
 */
function getCommentsPager(shortcode) {
    if (commentCache[shortcode])
       return commentCache[shortcode];

    const instances = getKittygramInstances();
    let found = null;

    // Reuse HTML cached by fetchKittygramPostData if available (common flow:
    // user opens video details first, then scrolls to comments)
    const cachedHtml = pageHtmlCache[shortcode];
    if (cachedHtml) {
        try {
            const postDoc = domParser.parseFromString(cachedHtml, 'text/html');
            const videoDatetime = datetimeCache[shortcode] || extractPostDatetime(postDoc);
            const comments = parseKittygramPostPageComments(cachedHtml, shortcode, videoDatetime);
            found = new InstagramCommentPager(comments, false, { shortcode: shortcode, instance: '' });
        } catch (e) {
            log('getCommentsPager: cached HTML parse error: ' + e);
        }
    }

    if (!found) {
        instances.some(function(instance) {
            try {
                const resp = httpGET(instance + '/p/' + shortcode);

                if (resp && resp.isOk && resp.body) {
                    const postDoc = domParser.parseFromString(resp.body, 'text/html');
                    const videoDatetime = datetimeCache[shortcode] || extractPostDatetime(postDoc);
                    const comments = parseKittygramPostPageComments(resp.body, shortcode, videoDatetime);
                    found = new InstagramCommentPager(comments, false, { shortcode: shortcode, instance: instance });
                    return true;
                }
            } catch (e) {
                log('getCommentsPager: error: ' + e);
            }
            return false;
        });
    }

    if (found) {
       commentCache[shortcode] = found;
       return found;
    }
    bridge.toast('Failed to load comments');
    return new InstagramCommentPager([], false, { shortcode: shortcode });
}

/**
 * Creates a PlatformAuthorLink using the platform's ID format.
 * @param {string} name - Author username
 * @param {string} url - Author profile URL
 * @param {string} [avatar] - Author avatar URL
 * @returns {PlatformAuthorLink}
 */
function getAuthor(name, url, avatar) {
    return new PlatformAuthorLink(
        new PlatformID(
            platform.title, 
            name, 
            config.id
        ), 
        name, 
        url, 
        avatar || ''
    );
}

/**
 * Creates a PlatformVideoDetails from parsed metadata.
 * @param {Object} meta - Parsed metadata
 * @param {string} shortcode - Post/reel shortcode
 * @param {string} stringUrl - Original URL
 * @param {string} authorAvatar - Author avatar URL (empty string if none)
 * @param {number|null} [likes] - Like count (null if none)
 * @returns {PlatformVideoDetails}
 */
function getVideoDetails(meta, shortcode, stringUrl, authorAvatar, likes) {
    // Build PlatformVideoDetails with video metadata.
    // Width, height, and codec are extracted from the Kittygram post page when available,
    // falling back to standard 720x1280 reels defaults.
    const thumbUrl = meta.thumbnail || platform.icon;
    const videoWidth = meta.width || 720;
    const videoHeight = meta.height || 1280;
    const videoCodec = meta.codec || 'avc1';
    return new PlatformVideoDetails({
        id: new PlatformID(platform.title, shortcode, config.id),
        name: meta.title.substring(0, 100),
        thumbnails: new Thumbnails([new Thumbnail(thumbUrl, 0)]),
        author: getAuthor(meta.authorName, stringUrl, authorAvatar || ''),
        url: stringUrl,
        uploadDate: meta.datetime,
        duration: meta.duration,
        description: meta.description,
        isLive: false,
        rating: likes ? new RatingLikes(likes) : null,
        video: new VideoSourceDescriptor([new VideoUrlSource({
            width: videoWidth, height: videoHeight, container: 'video/mp4', codec: videoCodec,
            name: 'mp4', bitrate: 2000000, duration: meta.duration || 30, url: meta.videoUrl
        })])
    });
}

/**
 * Parses a Kittygram search result card element into a PlatformChannel object.
 * @param {Element} card - A DOM element with class .user-info.item-card.search-result
 * @returns {PlatformChannel|null} A PlatformChannel if parsing succeeds, or null if required fields are missing
 */
function parseChannelFromCard(card) {
    // Convert a Kittygram search result card into a PlatformChannel
    const usernameLink = card.querySelector('a.username');
    if (!usernameLink)
       return null;

    const avatarImg = card.querySelector('img');

    const username = usernameLink.getAttribute('href').replace('/', '');
    let avatar = null;
    if (avatarImg) {
        const src = avatarImg.getAttribute('src');
        if (src)
           avatar = decodeKittygramProxy(src);
    }
    
    return new PlatformChannel({
        id: new PlatformID(platform.title, username, config.id),
        name: username,
        thumbnail: avatar || platform.icon,
        banner: avatar || '',
        subscribers: 0,
        description: '',
        url: platform.regular_url + '/' + encodeURIComponent(username) + '/',
        links: {}
    });
}

/**
 * Fetches and assembles a PlatformChannel for the given username.
 * Tries web API, HTML meta tags, LD+JSON, regex extraction, and Kittygram fallback.
 * @param {string} username - Instagram username
 * @returns {PlatformChannel}
 */
function getPlatformChannel(username) {
    let displayName = username;
    let thumbnail = null;
    let description = '';
    let subscriberCount = null;

    // Fetch profile from Kittygram
    try {
        const kgResult = fetchFromKittygram(username);
        if (kgResult && kgResult.profile) {
            if (kgResult.profile.name)
               displayName = kgResult.profile.name;
            if (kgResult.profile.thumbnail)
               thumbnail = kgResult.profile.thumbnail;
            if (kgResult.profile.followers)
               subscriberCount = kgResult.profile.followers;
            if (kgResult.profile.bio)
               description = kgResult.profile.bio;
        }
    } catch (e) {
        log('getPlatformChannel: error: ' + e);
    }

    return new PlatformChannel({
        id: new PlatformID(platform.title, username, config.id),
        name: displayName,
        thumbnail: thumbnail || platform.icon,
        banner: platform.banner,
        subscribers: subscriberCount,
        description: description,
        url: platform.regular_url + '/' + encodeURIComponent(username) + '/',
        links: {}
    });
}

/**
 * Searches for Instagram channels across Kittygram instances.
 * Tries each instance in order until results are found.
 * @param {string} query - The search query string
 * @returns {PlatformChannel[]} Array of matching PlatformChannel objects
 */
function searchKittygramChannels(query) {
    // Search all Kittygram instances for channels matching a query
    const channels = [];
    getKittygramInstances().some(function(instance) {
        try {
            const resp = httpGET(instance + '/search?q=' + encodeURIComponent(query));

            if (resp && resp.isOk && resp.body) {
                const cards = domParser.parseFromString(resp.body, 'text/html').querySelectorAll('.user-info.item-card.search-result');
                cards.forEach(function(card) {
                    const ch = parseChannelFromCard(card);
                    if (ch)
                       channels.push(ch);
                });

                if (channels.length > 0)
                   return true;
            }
        } catch (e) {
            log('searchKittygramChannels: ' + e);
        }
        return false;
    });
    return channels;
}

/**
 * Gets a Kittygram instance URL by index, falling back to the first instance.
 * @param {number} idx - Instance index
 * @returns {string} Kittygram instance URL
 */
function getKittygramInstanceUrl(idx) {
    // Get Kittygram instance URL by index, defaulting to first
    if (idx >= 0 && idx < KITTYGRAM_INSTANCES.length) {
        return KITTYGRAM_INSTANCES[idx];
    }
    return KITTYGRAM_INSTANCES[0];
}

/**
 * Returns Kittygram instances with the user's preferred instance first.
 * @returns {string[]} Ordered array of Kittygram instance URLs
 */
function getKittygramInstances() {
    const preferred = getKittygramInstanceUrl(settings.kittygramInstance);
    
    // Sort Kittygram instances with preferred going first
    const rest = KITTYGRAM_INSTANCES[0] === preferred
        ? KITTYGRAM_INSTANCES.slice(1)
        : KITTYGRAM_INSTANCES.filter(function(i) { return i !== preferred; });

    return [preferred].concat(rest);
}

/**
 * Resolves the best thumbnail URL for a feed item by trying multiple source fields.
 * Falls back to HTML metadata extraction for items without direct thumbnail fields.
 * @param {Object} item - Feed item object
 * @param {string} fallbackThumb - Default thumbnail (usually profile thumbnail)
 * @param {string|null} html - Profile page HTML for HTML fallback extraction
 * @param {string|null} shortcode - Post shortcode for HTML fallback extraction
 * @returns {string} Resolved thumbnail URL
 */
function resolveItemThumbnail(item, fallbackThumb) {
    if (item.thumbnail && item.thumbnail !== fallbackThumb)
        return item.thumbnail;
    return fallbackThumb;
}

/**
 * Gets a paginated list of channel content (posts and reels) for an Instagram user.
 * Sources items from Kittygram API, HTML shortcode extraction, or Kittygram fallback.
 * Supports filtering by shorts-only, text query search, and chronological sorting.
 * @param {string} url - Channel URL
 * @param {string} type - Feed type (Type.Feed.Shorts or Type.Feed.Mixed)
 * @param {string} order - Sort order
 * @param {Array} filters - Active filters
 * @param {string|null} continuationToken - Pagination cursor for next page
 * @param {string|null} query - Text search query within channel content
 * @returns {InstagramVideoPager} Paginated video/post results
 */
function getChannelContentPager(url, type, order, filters, continuationToken, query) {
    const username = extractUsername(url);
    if (!username)
        return new VideoPager([], false);

    const wantShorts = (type === Type.Feed.Shorts);
    const queryLower = query ? query.toLowerCase() : null;

    let items = null;
    let hasMore = false;
    let nextCursor = null;
    let kgProfile = null;
    let kgWorkingInstance = null;

    const isKittygramCursor = continuationToken && typeof continuationToken === 'string' && continuationToken.indexOf('kg_') === 0;
    if (!continuationToken || isKittygramCursor) {
        const kgCursor = isKittygramCursor ? continuationToken.substring(3) : null;
        const kgResult = fetchFromKittygram(username, kgCursor);
        if (kgResult && kgResult.items && kgResult.items.length > 0) {
            items = kgResult.items;
            hasMore = kgResult.hasMore || false;
            nextCursor = kgResult.nextCursor ? 'kg_' + kgResult.nextCursor : null;
            kgProfile = kgResult.profile;
            kgWorkingInstance = kgResult.workingInstance;
        }
    }

    if (!items || items.length === 0) {
        const kgFallback = fetchFromKittygram(username);
        if (kgFallback && kgFallback.items && kgFallback.items.length > 0) {
            items = kgFallback.items;
            kgProfile = kgFallback.profile;
            kgWorkingInstance = kgFallback.workingInstance;
        }
    }

    const profileThumbnail = kgProfile && kgProfile.thumbnail ? kgProfile.thumbnail : platform.icon;

    const videos = [];
    const seen = {};

    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const shortcode = item.code || item.id;
            if (!shortcode || seen[shortcode])
                continue;
            seen[shortcode] = true;

            const isVideo = !!(item.isVideo || item.videoUrl);
            if (wantShorts && !isVideo)
                continue;

            // Parse caption
            let title = 'Instagram Post';
            let itemCaption = null;
            try { itemCaption = item.caption && (item.caption.text || item.caption); } catch {}
            if (itemCaption && itemCaption !== '')
                title = itemCaption.substring(0, 100);

            // Resolve thumbnail
            const itemThumb = resolveItemThumbnail(item, profileThumbnail);

            // Compute durations
            const duration = item.duration ? Math.round(item.duration) : null;
            const datetime = item.taken_at || null;

            // Determine video URL
            const itemVideoUrl = item.videoUrl || null;

            // Populate caches (used by getContentDetails for fast cached load)
            if (itemVideoUrl)
                videoUrlCache[shortcode] = itemVideoUrl;
            if (itemThumb && itemThumb !== platform.icon)
                thumbnailCache[shortcode] = itemThumb;
            if (item.likes)
                likesCache[shortcode] = item.likes;
            if (item.taken_at)
                datetimeCache[shortcode] = item.taken_at;
            feedItemCache[shortcode] = {
                title: title,
                description: itemCaption || '',
                thumbnail: itemThumb || '',
                authorName: username,
                authorThumb: profileThumbnail,
                duration: duration,
                datetime: datetime,
                videoUrl: itemVideoUrl
            };

            // Build content URL
            const contentUrl = (settings.useInstagramUrlsForSharing && platform.regular_url || kgWorkingInstance || platform.regular_url) + (isVideo ? '/reel/' : '/p/') + shortcode + '/';

            const itemLikes = item.likes || null;

            const entry = isVideo ? new PlatformVideo({
                id: new PlatformID(platform.title, shortcode, config.id),
                name: title,
                thumbnails: new Thumbnails([new Thumbnail(itemThumb, 0)]),
                author: getAuthor(username, url, profileThumbnail),
                datetime: datetime,
                duration: duration,
                viewCount: itemLikes,
                url: contentUrl,
                isLive: false,
                rating: itemLikes ? new RatingLikes(itemLikes) : null
            }) : new PlatformPostDetails({
                id: new PlatformID(platform.title, shortcode, config.id),
                name: title,
                author: getAuthor(username, url, profileThumbnail),
                datetime: datetime,
                url: contentUrl,
                description: itemCaption || '',
                images: itemThumb ? [itemThumb] : [],
                thumbnails: itemThumb ? [new Thumbnails([new Thumbnail(itemThumb, 0)])] : [],
                textType: Type.Text.Raw,
                content: itemCaption || '',
                rating: itemLikes ? new RatingLikes(itemLikes) : null
            });

            const caption = itemCaption || '';
            if (queryLower) {
                const searchText = (entry.name + ' ' + caption).toLowerCase();
                if (searchText.indexOf(queryLower) === -1)
                    continue;
            }

            videos.push(entry);
        }
    }

    if (settings && settings.sortUploads !== false)
        videos.sort(function(a, b) { return (b.datetime || 0) - (a.datetime || 0); });

    return new InstagramVideoPager(videos, hasMore && !!nextCursor, { username: username, cursor: nextCursor, wantShorts: wantShorts });
}



/**
 * Fetches a user's timeline from Kittygram instances.
 * Returns { items, profile, nextCursor, hasMore } where items are rich objects and profile has name/thumbnail/followers.
 * Tries each instance in order and returns on first success with items.
 * @param {string} username - Instagram username
 * @param {string|null} afterCursor - Pagination cursor (post ID for next page)
 * @returns {Object|null} Parsed result with items and pagination info
 */
function fetchFromKittygram(username, afterCursor) {
    const instances = getKittygramInstances();

    let result = null;
    let workingInstance = null;
    let switched = false;
    instances.some(function(instance) {
        try {
            let url = instance + '/' + encodeURIComponent(username) + '/';
            if (afterCursor)
               url += '?after=' + encodeURIComponent(afterCursor);

            const resp = httpGET(url);
            if (resp && resp.isOk && resp.body) {
                const parsed = parseKittygramHtmlWithPagination(resp.body, username);
                if (parsed.items && parsed.items.length > 0) {
                    result = parsed;
                    workingInstance = instance;
                    return true;
                }
            } else if (resp) {
                switched = true;
                bridge.toast('Request failed, switching instance');
            }
        } catch {
            switched = true;
            bridge.toast('Request failed, switching instance');
        }
        return false;
    });

    if (switched && workingInstance)
       bridge.toast('Switched to: ' + workingInstance);

    if (result)
        result.workingInstance = workingInstance;
    return result;
}

/**
 * Decodes a Kittygram /mediaproxy?url=<encoded> src attribute into a real CDN URL.
 * @param {string} proxySrc - e.g. "/mediaproxy?url=https%3a%2f%2fscontent..."
 * @returns {string|null} The decoded CDN URL, or null
 */
function decodeKittygramProxy(proxySrc) {
    if (!proxySrc)
       return null;
    try {
        const match = proxySrc.match(/\/mediaproxy\?url=(.+)/);
        return match ? decodeURIComponent(match[1]) : null;
    } catch {
        return null;
    }
}

/**
 * Extracts the best available thumbnail from a Kittygram document (post page or card).
 * Checks video[poster] first, falls back to img[src], filtering "nil" placeholders.
 * @param {Document} doc - Parsed Kittygram HTML document
 * @returns {string|null} Decoded thumbnail URL, or null
 */
function extractThumbnail(doc) {
    const postImageDiv = doc.querySelector('.post-image');
    if (!postImageDiv) return null;
    const videoEl = postImageDiv.querySelector('video');
    if (videoEl) {
        const poster = videoEl.getAttribute('poster');
        if (poster && poster !== 'nil') return decodeKittygramProxy(poster);
    }
    const imgEl = postImageDiv.querySelector('img');
    if (imgEl) {
        const src = imgEl.getAttribute('src');
        if (src && src !== 'nil') return decodeKittygramProxy(src);
    }
    return null;
}

/**
 * Extracts the like count from a Kittygram document.
 * @param {Document} doc - Parsed Kittygram HTML document
 * @returns {number|null} Like count, or null
 */
function extractLikes(doc) {
    const likesEl = doc.querySelector('.post-likes');
    if (!likesEl)
       return null;
    const likesText = likesEl.textContent || '';
    if (likesText.toLowerCase().indexOf('nil') !== -1)
       return null;
    const likesMatch = likesText.match(/([\d,]+)/);
    if (!likesMatch)
       return null;
    const num = parseInt(likesMatch[1].replace(/,/g, ''), 10);
    return isNaN(num) ? null : num;
}

/**
 * Converts a "YYYY-MM-DD HH:MM:SS" datetime string to a Unix timestamp via Date.UTC.
 * @param {string} str - Datetime string
 * @returns {number|null} Unix timestamp in seconds, or null if unparseable
 */
function parseDatetimeToUnix(str) {
    if (!str || typeof str !== 'string')
       return null;
    const m = str.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m)
       return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
}

/**
 * Extracts profile info from a Kittygram HTML page DOM.
 * @param {string} html - Kittygram profile page HTML
 * @returns {Object|null} { name, thumbnail, bio, followers } or null
 */
function parseKittygramProfile(html) {
    // Extract profile info from Kittygram HTML DOM
    try {
        const doc = domParser.parseFromString(html, 'text/html');
        const profPicDiv = doc.querySelector('.profile-picture');
        let thumb = null;
        if (profPicDiv) {
            const img = profPicDiv.querySelector('img');
            if (img) {
                const src = img.getAttribute('src');
                if (src)
                   thumb = decodeKittygramProxy(src);
            }
        }
        const nameDiv = doc.querySelector('.usernames');
        let name = null;
        if (nameDiv) {
            const h3 = nameDiv.querySelector('h3');
            if (h3)
               name = h3.textContent.trim();
        }
        const bioDiv = doc.querySelector('.user-bio-text');
        const bio = bioDiv ? bioDiv.textContent.trim() : null;
        let followers = null;
        const statNumbers = doc.querySelectorAll('.stat-number');
        if (statNumbers.length > 0) {
            const fNum = parseInt(statNumbers[0].textContent.replace(/,/g, ''), 10);
            if (!isNaN(fNum))
               followers = fNum;
        }
        if (name || thumb)
           return { name: name, thumbnail: thumb, bio: bio, followers: followers };
    } catch (e) {
        log('parseKittygramProfile: error: ' + e);
    }
    return null;
}

/**
 * Extracts duration from a decoded Kittygram video URL.
 * Tries JSON, EFG parameter, and base64 EFG formats.
 * @param {string} url - Decoded video URL
 * @returns {number|null} Duration in seconds, or null
 */
function extractDurationFromUrl(url) {
    if (!url)
       return null;
    let match = url.match(/"duration_s"\s*:\s*(\d+)/);
    if (match)
       return parseInt(match[1], 10);
    const efgMatch = url.match(/efg=([^&]+)/);
    if (!efgMatch)
       return null;
    try {
        const decoded = decodeURIComponent(efgMatch[1]);
        match = decoded.match(/"duration_s"\s*:\s*(\d+)/);
        if (match)
           return parseInt(match[1], 10);
        let base64 = decoded.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        match = atob(base64).match(/"duration_s"\s*:\s*(\d+)/);
        if (match)
           return parseInt(match[1], 10);
    } catch {}
    return null;
}

/**
 * Parses a single Kittygram card HTML fragment into a post item.
 * @param {string} card - HTML fragment for a single post card
 * @returns {Object|null} { code, videoUrl, thumbnail, caption, taken_at, isVideo, likes, comments, duration } or null
 */
function parseKittygramCard(card) {
    const scMatch = card.match(/href="\/p\/([A-Za-z0-9_-]{5,})"/);
    if (!scMatch)
       return null;
    const shortcode = scMatch[1];

    let videoUrl = null;
    let isVideo = false;
    let duration = null;
    const sourceMatch = card.match(/<source\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
    if (sourceMatch) {
        isVideo = true;
        videoUrl = decodeKittygramProxy(sourceMatch[1]);
        const cardDuration = extractDurationFromUrl(videoUrl);
        if (cardDuration)
           duration = cardDuration;
    }

    const cardDoc = domParser.parseFromString(card, 'text/html');
    const thumbnail = extractThumbnail(cardDoc);

    const captionMatch = card.match(/class="post-caption-text"[^>]*>([\s\S]*?)<\/p>/);
    let caption = null;
    if (captionMatch) {
        caption = captionMatch[1]
            .replace(/&#039;/g, "'").replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/<[^>]+>/g, '').trim();
    }

    let takenAt = null;
    const timeMatch = card.match(/Posted at:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (timeMatch)
       takenAt = parseDatetimeToUnix(timeMatch[1]);
    if (!takenAt) {
        const timeEl = cardDoc.querySelector('time');
        if (timeEl) {
            const dt = timeEl.getAttribute('datetime');
            if (dt)
               takenAt = parseDatetimeToUnix(dt);
        }
    }

    const likes = extractLikes(cardDoc);

    const commentsRegex = new RegExp('href="/p/' + shortcode + '"[^>]*>(\\d+)\\s+Comments?</a>');
    const commentsMatch = card.match(commentsRegex);
    let comments = null;
    if (commentsMatch) {
        const commentsNum = parseInt(commentsMatch[1], 10);
        if (!isNaN(commentsNum))
           comments = commentsNum;
    }

    return {
        code: shortcode,
        videoUrl: videoUrl,
        thumbnail: thumbnail,
        caption: caption ? { text: caption } : null,
        taken_at: takenAt,
        isVideo: isVideo,
        likes: likes,
        comments: comments,
        duration: duration
    };
}

/**
 * Parses a Kittygram profile/timeline HTML page using regex and DOM.
 * Returns { items, profile } where each item has:
 *   code, videoUrl, thumbnail, caption, taken_at, isVideo, likes, comments, duration
 * and profile has: name, thumbnail, followers, bio
 */
function parseKittygramHtml(html, username) {
    // Split Kittygram HTML into post cards and parse each one
    const profile = parseKittygramProfile(html);
    const items = [];
    const seen = {};
    const cardRegex = /<div class="item-card post">/g;
    let match;
    while ((match = cardRegex.exec(html)) !== null) {
        const cardStart = match.index;
        const remaining = html.substring(cardStart + match[0].length);
        const nextCardMatch = remaining.match(/<div class="item-card post">/);
        const cardEnd = nextCardMatch ? html.indexOf('<div class="item-card post">', cardStart + match[0].length) : html.length;
        const card = cardEnd === html.length ? remaining : html.substring(cardStart, cardEnd);
        const item = parseKittygramCard(card);
        if (item && !seen[item.code]) {
            seen[item.code] = true;
            items.push(item);
        }
    }
    return { items: items, profile: profile };
}

/**
 * Parses a Kittygram profile/timeline HTML page and extracts pagination info.
 * Returns { items, profile, nextCursor, hasMore }.
 */
function parseKittygramHtmlWithPagination(html, username) {
    // Parse Kittygram HTML with pagination cursor extraction
    const result = parseKittygramHtml(html, username);
    let nextCursor = null;
    let hasMore = false;

    try {
        const match = html.match(/href="(\?after=[^"]+)"\s+class="next-button"/);
        if (match && match[1]) {
            nextCursor = match[1].replace('?after=', '');
            hasMore = nextCursor.length > 0;
        }
    } catch {}

    return { items: result.items, profile: result.profile, nextCursor: nextCursor, hasMore: hasMore };
}

/**
 * Fetches a post page from Kittygram and returns video URL, thumbnail, and metadata.
 * @param {string} shortcode - Post shortcode
 * @returns {{ videoUrl: string|null, thumbnail: string|null, caption: string|null, author: string|null, datetime: number|null }}
 */
function fetchKittygramPostData(shortcode) {
    // Fetch a single post from Kittygram instances and extract all fields
    const instances = getKittygramInstances();
    let result = null;

    instances.some(function(instance) {
        try {
            const url = instance + '/p/' + shortcode;
            const resp = httpGET(url);
            if (resp && resp.isOk && resp.body) {
                const body = resp.body;

                let videoUrl = null;
                let thumbnail = null;
                let caption = null;
                let author = null;
                let datetime = null;
                let duration = null;
                let videoWidth = null;
                let videoHeight = null;
                let videoCodec = null;
                let images = [];

                const sourceMatch = body.match(/<source\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
                if (sourceMatch) {
                    videoUrl = decodeKittygramProxy(sourceMatch[1]);
                    duration = extractDurationFromUrl(videoUrl);
                    // Extract codec from source type attribute (e.g., 'video/mp4; codecs=avc1.64001F')
                    const typeMatch = body.match(/<source[^>]*type="([^"]+)"/);
                    if (typeMatch) {
                        const codecMatch = typeMatch[1].match(/codecs=["']?([^"'\s;]+)/);
                        if (codecMatch) videoCodec = codecMatch[1];
                    }
                }

                const bodyDoc = domParser.parseFromString(body, 'text/html');
                thumbnail = extractThumbnail(bodyDoc);

                // Extract video dimensions from the video element (separate from thumbnail)
                const postImageDiv = bodyDoc.querySelector('.post-image');
                if (postImageDiv) {
                    const videoEl = postImageDiv.querySelector('video');
                    if (videoEl) {
                        const widthAttr = videoEl.getAttribute('width');
                        const heightAttr = videoEl.getAttribute('height');
                        if (widthAttr) videoWidth = parseInt(widthAttr, 10);
                        if (heightAttr) videoHeight = parseInt(heightAttr, 10);
                    }
                    // Extract all images from carousel gallery (multi-image posts)
                    const carousel = postImageDiv.querySelector('.carousel');
                    if (carousel) {
                        const imgs = carousel.querySelectorAll('img');
                        imgs.forEach(function(img) {
                            const src = img.getAttribute('src');
                            if (src && src !== 'nil') {
                                const decoded = decodeKittygramProxy(src);
                                if (decoded)
                                    images.push(decoded);
                            }
                        });
                    }
                }

                const captionMatch = body.match(/class="post-caption-text"[^>]*>([\s\S]*?)<\/p>/);
                if (captionMatch) {
                    caption = captionMatch[1]
                        .replace(/&#039;/g, "'").replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                        .replace(/<[^>]+>/g, '').trim();
                }

                const authorMatch = body.match(/class="user-info"[\s\S]*?class="username"[^>]*>([^<]+)/);
                if (authorMatch)
                   author = authorMatch[1].trim();

                const authorThumbMatch = body.match(/class="user-info"[\s\S]*?<img\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
                const authorThumb = authorThumbMatch ? decodeKittygramProxy(authorThumbMatch[1]) : '';

                const timeEl = bodyDoc.querySelector('time.post-time');
                if (timeEl) {
                    const dt = timeEl.getAttribute('datetime');
                    if (dt)
                       datetime = parseDatetimeToUnix(dt);
                }
                if (!datetime) {
                    const timeMatch = body.match(/Posted at:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                    if (timeMatch)
                       datetime = parseDatetimeToUnix(timeMatch[1]);
                }

                let likes = extractLikes(bodyDoc);
                if (likes == null) {
                    const bodyText = bodyDoc.body ? bodyDoc.body.textContent : '';
                    if (bodyText.toLowerCase().indexOf('nil likes') === -1) {
                        const likesMatch2 = bodyText.match(/([\d,]+)\s*likes?/i);
                        if (likesMatch2) {
                            const likesNum2 = parseInt(likesMatch2[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum2))
                               likes = likesNum2;
                        }
                    }
                }

                if (videoUrl || thumbnail || images.length > 0) {
                    result = { videoUrl: videoUrl, thumbnail: thumbnail, images: images, caption: caption, author: author, authorThumb: authorThumb, datetime: datetime, likes: likes, duration: duration, width: videoWidth, height: videoHeight, codec: videoCodec };

                    // Cache raw HTML for getCommentsPager reuse
                    pageHtmlCache[shortcode] = body;

                    // Cache thumbnail and likes for cross-call reuse (e.g., getChannelContentPager)
                    if (thumbnail) thumbnailCache[shortcode] = thumbnail;
                    if (likes != null) likesCache[shortcode] = likes;

                    return true;
                }
            }
        } catch {}
        return false;
    });

    // Channel page fallback: Kittygram reels often have poster="nil", so the post
    // page returns no thumbnail. Fetch the author's channel page and scan for a
    // matching post card to extract thumbnail and likes.
    if (result && (!result.thumbnail || result.likes == null) && result.author) {
        // Check caches first (may have been populated by getChannelContentPager)
        if (!result.thumbnail && thumbnailCache[shortcode])
            result.thumbnail = thumbnailCache[shortcode];
        if (result.likes == null && likesCache[shortcode] != null)
            result.likes = likesCache[shortcode];

        if (!result.thumbnail || result.likes == null) {
            try {
                const kgResult = fetchFromKittygram(result.author);
                if (kgResult && kgResult.items) {
                    for (let i = 0; i < kgResult.items.length; i++) {
                        const item = kgResult.items[i];
                        if (item.code !== shortcode) continue;
                        if (!result.thumbnail && item.thumbnail)
                            result.thumbnail = item.thumbnail;
                        if (result.likes == null && item.likes != null)
                            result.likes = item.likes;
                        break;
                    }
                    if (result.thumbnail) thumbnailCache[shortcode] = result.thumbnail;
                    if (result.likes != null) likesCache[shortcode] = result.likes;
                }
            } catch (e) {
                log('fetchKittygramPostData: channel fallback error: ' + e);
            }
        }
    }

    return result || { videoUrl: null, thumbnail: null, images: [], caption: null, author: null, authorThumb: '', datetime: null, likes: null, duration: null, width: null, height: null, codec: null };
}

/**
 * Parses a URL into its non-empty path segments.
 * @param {string} url - Full URL to parse
 * @returns {string[]|null} Array of path segments, or null on failure
 */
function urlSegments(url) {
    try {
        return new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean);
    } catch { 
        return null; 
    }
}

/**
 * Extracts the username from an Instagram profile URL's first path segment.
 * @param {string} url - Full Instagram URL
 * @returns {string|null} Username, or null if unparseable
 */
function extractUsername(url) {
    const segments = urlSegments(url);
    return segments && segments.length > 0 ? segments[0] : null;
}


class InstagramCommentPager extends CommentPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        if (!this.hasMore || !this.context || !this.context.shortcode) {
            return new InstagramCommentPager([], false, this.context);
        }
        return source.getComments(platform.regular_url + '/p/' + this.context.shortcode + '/');
    }
}

class InstagramVideoPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        return source.getChannelContents(
            platform.regular_url + '/' + encodeURIComponent(this.context.username) + '/',
            this.context.wantShorts ? Type.Feed.Shorts : Type.Feed.Mixed,
            Type.Order.Chronological,
            null,
            this.context.cursor
        );
    }
}
