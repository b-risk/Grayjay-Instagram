// ─── Platform Information ───────────────────────────────────────────────
const platform = {
    title: 'Instagram',
    regular_url: 'https://www.instagram.com',
    url: 'https://www.instagram.com/',
    icon: 'https://static.cdninstagram.com/rsrc.php/yn/r/Puw_9ASeZc1.webp',
    banner: 'https://raw.githubusercontent.com/username/Grayjay-Instagram/main/Imgs/channel-banner.jpg',
    description: 'Instagram is a photo and video sharing social networking service owned by Meta Platforms.'
};

// ─── API URLs ──────────────────────────────────────────────────────────
const API_URLS = {
    base: 'https://www.instagram.com',
    graphql: '/graphql/query/',
    homepage: '/',
    embed: '/embed/',
    api_v1: '/api/v1/',
    upload: '/upload/'
};

// ─── Constants ──────────────────────────────────────────────────────────
const USER_AGENT = 'Mozilla/5.0';
const IG_APP_ID = '1217981644879628';
const IG_APP_ID_ALT = '936619743392459'; // Alternate app ID used by drawrowfly/instagram-scraper
const EXCLUDED_USER_PATHS = ['reel', 'p', 'explore', 'accounts', 'direct', 'stories', 'saved', 'search', 'tags', 'about', 'legal', 'help', 'blog'];

const KITTYGRAM_INSTANCES = [
    'https://kittygram.irelephant.net',
    'https://kittygr.am',
    'https://kittygram.kareem.one',
    'https://kg.lus.lu',
    'https://kg.meowing.de',
    'https://kittygram.nexussfan.cz'
];

// Known GraphQL query hashes for Instagram's web client.
// These map to specific queries and may change when Instagram updates their codebase.
const QUERY_HASHES = {
    userInfo: 'c9100bf9110dd6361671f113dd02e7b6',          // user() by username
    userMedia: '42323d64886122307be10013ad2dcc44',          // edge_owner_to_timeline_media
    reelMedia: 'b3055c01c4f53b8a1c3c5b7b8f0c5e5b',         // edge_felix_video_timeline
    mediaInfo: '2befcba8c35175b2f80c75e2f2c2fcec'          // shortcode_media()
};

// ─── State ─────────────────────────────────────────────────────────────
let config = {};
let settings = {};
let lsdToken = null;
let midCookie = null;
let cookieStore = '';        // All cookies captured from Instagram, sent back on requests
let videoUrlCache = {};      // shortcode → video URL (cached from feed API)
let feedItemCache = {};      // shortcode → feed item data (cached for reuse)
let thumbnailCache = {};     // shortcode → resolved thumbnail URL (from getChannelContents)
let likesCache = {};         // shortcode → like count (from channel feed cards)
let datetimeCache = {};      // shortcode → datetime (from channel feed cards)

// ═══════════════════════════════════════════════════════════════════════
// SOURCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

// Called by Grayjay when the plugin is first loaded
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

// Checks whether a URL is an Instagram profile page
source.isChannelUrl = function (url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        if (host !== 'www.instagram.com' && host !== 'instagram.com') return false;

        const pathname = parsed.pathname.replace(/\/$/, '');
        const parts = pathname.split('/').filter(Boolean);

        if (parts.length === 0) return true;
        if (parts.length !== 1) return false;

        return !EXCLUDED_USER_PATHS.includes(parts[0]);
    } catch {
        return false;
    }
}

// Get channel (user profile) details
source.getChannel = function (url) {
    log('getChannel: ' + url);
    const username = extractUsername(url);

    // Return an exception if the URL is invalid or points to a non-user path
    if (!username || EXCLUDED_USER_PATHS.includes(username))
        throw new ScriptException('Instagram channel not found');

    // Fetch profile data from both HTML (meta tags) and web API (richer data)
    var displayName = username;
    var thumbnail = null;
    var description = '';
    var subscriberCount = null;

    // Try web API first for better data
    var session = getSession();
    if (session.lsd && session.mid) {
        var profileData = fetchWebProfile(username, session);
        if (profileData && profileData.data && profileData.data.user) {
            var user = profileData.data.user;
            displayName = user.full_name || user.username || displayName;
            thumbnail = user.profile_pic_url_hd || user.profile_pic_url || thumbnail;
            description = user.biography || description;
            var followerCount = user.edge_followed_by && user.edge_followed_by.count;
            if (!followerCount) followerCount = user.follower_count;
            if (followerCount) subscriberCount = followerCount;
        } else {
            
        }
    }

    // Fall back to HTML meta tags and embedded data
    if (!thumbnail) {
        const response = http.GET(API_URLS.base + '/' + encodeURIComponent(username) + '/', defaultHeaders(), false);
        if (response && response.isOk) {
            // Try OG meta tags
            const meta = extractMetaTags(response.body);
            if (meta) {
                if (meta.title && displayName === username) {
                    var match = meta.title.match(/^([^(]+)/);
                    if (match) displayName = match[1].trim();
                    if (!displayName) displayName = username;
                }
                thumbnail = meta.image || thumbnail;
                if (meta.description && !description) description = meta.description;
            }
            // Try LD+JSON profile data
            if (!thumbnail || displayName === username) {
                try {
                    var ldProfile = extractLdProfile(response.body);
                    if (ldProfile && ldProfile.user) {
                        if (displayName === username) displayName = ldProfile.user.name || displayName;
                        if (!thumbnail) thumbnail = ldProfile.user.image || thumbnail;
                        if (ldProfile.user.subscriberCount) subscriberCount = ldProfile.user.subscriberCount;
                    }
                } catch {}
            }
            // Try regex extraction from raw HTML
            if (!thumbnail || displayName === username) {
                try {
                    var htmlMeta = extractChannelMetadataFromHtml(response.body, username);
                    if (htmlMeta) {
                        if (htmlMeta.name && displayName === username) displayName = htmlMeta.name;
                        if (htmlMeta.thumbnail && !thumbnail) thumbnail = htmlMeta.thumbnail;
                        if (htmlMeta.subscribers && !subscriberCount) subscriberCount = htmlMeta.subscribers;
                    }
                } catch {}
            }
        }
    }

    // Kittygram fallback: always try for followers if missing, and for other data if also missing
    log('getChannel: before Kittygram - thumbnail=' + (thumbnail ? 'yes' : 'no') + ' subscriberCount=' + subscriberCount + ' displayName=' + displayName);
    // Always try Kittygram for followers if subscriberCount is null, regardless of thumbnail
    var needKittygram = !subscriberCount || !thumbnail || displayName === username;
    if (needKittygram) {
        try {
            var kgResult = fetchFromKittygram(username);
            if (kgResult && kgResult.profile) {
                var kgProfile = kgResult.profile;
                if (kgProfile.name && displayName === username) displayName = kgProfile.name;
                if (kgProfile.thumbnail && !thumbnail) thumbnail = kgProfile.thumbnail;
                if (kgProfile.followers && !subscriberCount) subscriberCount = kgProfile.followers;
                if (kgProfile.bio && !description) description = kgProfile.bio;
                log('getChannel: Kittygram provided profile name=' + displayName + ' thumb=' + (thumbnail ? 'yes' : 'no') + ' subscribers=' + subscriberCount);
            }
        } catch (e) {
            log('getChannel: Kittygram profile fallback error: ' + e);
        }
    } else {
        log('getChannel: skipping Kittygram because have thumbnail and subscriberCount');
    }

    log('getChannel: final subscriberCount=' + subscriberCount);
    return new PlatformChannel({
        id: new PlatformID(platform.title, username, config.id),
        name: displayName,
        thumbnail: thumbnail || platform.icon,
        banner: thumbnail || '',
        subscribers: subscriberCount,
        description: description,
        url: API_URLS.base + '/' + encodeURIComponent(username) + '/',
        links: {}
    });
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

// Checks whether a URL is a photo post with /p/ path
source.isPostUrl = function (url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.replace(/\/$/, '');
        const host = parsed.hostname;
        if (host !== 'www.instagram.com' && host !== 'instagram.com') return false;
        return /\/p\/[A-Za-z0-9_-]+$/.test(pathname) && !pathname.endsWith('/p/');
    } catch {
        return false;
    }
}

// Checks whether a URL can be resolved via getContentDetails
source.isContentDetailsUrl = function (stringUrl) {
    try {
        const url = new URL(stringUrl);
        const pathname = url.pathname.replace(/\/$/, '');
        const host = url.hostname;

        if (host !== 'www.instagram.com' && host !== 'instagram.com') return false;

        // Match /reel/CODE or /username/reel/CODE
        if (/\/reel\/[A-Za-z0-9_-]+$/.test(pathname) && !pathname.endsWith('/reel/')) return true;
        // Match /p/CODE or /username/p/CODE
        if (/\/p\/[A-Za-z0-9_-]+$/.test(pathname) && !pathname.endsWith('/p/')) return true;

        return false;
    } catch {
        return false;
    }
}

// Get video details for a post/reel URL
source.getContentDetails = function (stringUrl) {
    log('getContentDetails: ' + stringUrl);

    var parsedUrl = new URL(stringUrl);
    var pathname = parsedUrl.pathname.replace(/\/$/, '');

    var shortcode = null;
    var reelMatch = pathname.match(/\/reel\/([A-Za-z0-9_-]+)/);
    if (reelMatch) shortcode = reelMatch[1];
    var pMatch = pathname.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (pMatch) shortcode = pMatch[1];
    if (!shortcode) {
        throw new ScriptException('Invalid Instagram URL');
    }

    if (videoUrlCache[shortcode]) {
        log('getContentDetails: using cached video URL for ' + shortcode);
        var cachedVideoUrl = videoUrlCache[shortcode];
        var cachedItem = feedItemCache[shortcode] || null;
        var itemTitle = 'Instagram Post';
        var itemDesc = '';
        var itemAuthor = 'Unknown';
        var itemThumb = '';
        var itemDuration = null;
        var itemDatetime = null;
        if (cachedItem) {
            try { itemTitle = (cachedItem.caption && (cachedItem.caption.text || cachedItem.caption)) || itemTitle; } catch {}
            try { itemDesc = (cachedItem.caption && (cachedItem.caption.text || cachedItem.caption)) || ''; } catch {}
            try {
                var versions = cachedItem.image_versions2 && cachedItem.image_versions2.candidates;
                if (versions && versions.length > 0) itemThumb = versions[0].url;
            } catch {}
            try { if (cachedItem.display_url && !itemThumb) itemThumb = cachedItem.display_url; } catch {}
            try { if (cachedItem.thumbnail_src && !itemThumb) itemThumb = cachedItem.thumbnail_src; } catch {}
            try { if (cachedItem.thumbnail_resources && cachedItem.thumbnail_resources.length > 0 && !itemThumb) itemThumb = cachedItem.thumbnail_resources[0].url; } catch {}
            try { if (cachedItem.video_duration) itemDuration = Math.round(cachedItem.video_duration); } catch {}
            try { if (cachedItem.taken_at) itemDatetime = cachedItem.taken_at; } catch {}
            try { if (cachedItem.user && cachedItem.user.username) itemAuthor = cachedItem.user.username; } catch {}
            try { if (cachedItem.owner && cachedItem.owner.username) itemAuthor = cachedItem.owner.username; } catch {}
        }
        itemTitle = typeof itemTitle === 'string' ? itemTitle.substring(0, 100) : 'Instagram Post';
        itemDesc = typeof itemDesc === 'string' ? itemDesc : '';
        var fallbackThumb = itemThumb || platform.icon;
        log('getContentDetails: cached path thumb=' + fallbackThumb.substring(0, 40) + '...');
        try {
        return new PlatformVideoDetails({
            id: new PlatformID(platform.title, shortcode, config.id),
            name: itemTitle,
            thumbnails: new Thumbnails([new Thumbnail(fallbackThumb, 0)]),
            author: new PlatformAuthorLink(
                new PlatformID(platform.title, itemAuthor, config.id),
                itemAuthor,
                stringUrl,
                ''
            ),
            url: stringUrl,
            uploadDate: itemDatetime,
            duration: itemDuration,
            description: itemDesc,
            isLive: false,
            video: new VideoSourceDescriptor(
                [new VideoUrlSource({
                    width: 608,
                    height: 1080,
                    container: 'video/mp4',
                    codec: 'avc1.4d401e',
                    name: 'mp4',
                    bitrate: 2000000,
                    duration: itemDuration || 30,
                    url: cachedVideoUrl
                })]
            )
        });
        } catch (e) {
            log('getContentDetails: cached path error: ' + e);
            videoUrlCache[shortcode] = null;
        }
    }

    log('getContentDetails: cache miss for ' + shortcode);

    var isReel = (/\/reel\//).test(pathname);
    var postTitle = 'Instagram Post';
    var postDescription = '';
    var postThumbnail = '';
    var authorName = 'Unknown';
    var authorThumb = '';
    var postDatetime = null;
    var videoUrl = null;
    var postLikes = null;
    var postDuration = null;

    // Try Kittygram first — avoids potentially hanging unauthenticated requests to Instagram
    try {
        log('getContentDetails: trying Kittygram for ' + shortcode);
        var kgPost = fetchKittygramPostData(shortcode);
        if (kgPost.videoUrl) {
            videoUrl = kgPost.videoUrl;
            log('getContentDetails: Kittygram videoUrl=' + videoUrl.substring(0, 60) + '...');
        }
        if (kgPost.thumbnail) postThumbnail = kgPost.thumbnail;
        if (kgPost.caption) {
            postTitle = kgPost.caption.substring(0, 100);
            postDescription = kgPost.caption;
        }
        if (kgPost.author) authorName = kgPost.author;
        if (kgPost.datetime) postDatetime = kgPost.datetime;
        if (kgPost.likes) postLikes = kgPost.likes;
        if (kgPost.duration) postDuration = kgPost.duration;
        if (kgPost.authorThumb) authorThumb = kgPost.authorThumb;
    } catch (e) {
        log('getContentDetails: Kittygram error: ' + e);
    }

    // If Kittygram gave us a video URL, return immediately without hitting Instagram at all
    if (videoUrl) {
        log('getContentDetails: returning PlatformVideoDetails with postDuration=' + postDuration);
        // Kittygram reels have poster="nil" — if no thumbnail from post page, fetch channel page
        if ((!postThumbnail || !postLikes) && authorName) {
            var kgHeaders = { 'User-Agent': USER_AGENT, 'Sec-Fetch-Mode': 'navigate' };
            var instances = getKittygramInstances();
            var foundFromChannel = false;
            for (var i = 0; i < instances.length && !foundFromChannel; i++) {
                var channelUrl = instances[i] + '/' + authorName;
                log('getContentDetails: fetching channel page for ' + channelUrl);
                var channelResp = http.GET(channelUrl, kgHeaders, false);
                if (channelResp && channelResp.isOk && channelResp.body) {
                    var channelDoc = domParser.parseFromString(channelResp.body, 'text/html');
                    var allCards = channelDoc.querySelectorAll('.item-card.post');
                    for (var c = 0; c < allCards.length; c++) {
                        var card = allCards[c];
                        var linkInCard = card.querySelector('a[href="/p/' + shortcode + '"]');
                        if (linkInCard) {
                            if (!postThumbnail) {
                                var cardVideo = card.querySelector('.post-image video');
                                if (cardVideo) {
                                    var poster = cardVideo.getAttribute('poster');
                                    if (poster && poster !== 'nil') {
                                        postThumbnail = decodeKittygramProxy(poster);
                                    }
                                }
                                if (!postThumbnail) {
                                    var cardImg = card.querySelector('.post-image img');
                                    if (cardImg) {
                                        var src = cardImg.getAttribute('src');
                                        if (src && src !== 'nil') postThumbnail = decodeKittygramProxy(src);
                                    }
                                }
                            }
                            if (!postLikes) {
                                var cardLikesEl = card.querySelector('.post-likes');
                                if (cardLikesEl) {
                                    var likesText = cardLikesEl.textContent || '';
                                    if (likesText.toLowerCase().indexOf('nil') === -1) {
                                        var likesMatch = likesText.match(/([\d,]+)/);
                                        if (likesMatch) {
                                            var likesNum = parseInt(likesMatch[1].replace(/,/g, ''), 10);
                                            if (!isNaN(likesNum)) postLikes = likesNum;
                                        }
                                    }
                                }
                            }
                            log('getContentDetails: got from channel page - thumb=' + (postThumbnail ? 'yes' : 'no') + ' likes=' + (postLikes || 'none'));
                            foundFromChannel = true;
                            break;
                        }
                    }
                }
            }
        }
        var thumbUrl = postThumbnail || platform.icon;
        var authorAvatar = authorThumb || platform.icon;
        return new PlatformVideoDetails({
            id: new PlatformID(platform.title, shortcode, config.id),
            name: postTitle,
            thumbnails: new Thumbnails([new Thumbnail(thumbUrl, 0)]),
            author: new PlatformAuthorLink(
                new PlatformID(platform.title, authorName, config.id),
                authorName,
                API_URLS.base + '/' + encodeURIComponent(authorName) + '/',
                authorAvatar
            ),
            url: stringUrl,
            uploadDate: postDatetime,
            duration: postDuration,
            description: postDescription,
            isLive: false,
            rating: postLikes ? new RatingLikes(postLikes) : null,
            video: new VideoSourceDescriptor([new VideoUrlSource({
                width: 720,
                height: 1280,
                container: 'video/mp4',
                codec: 'avc1',
                name: 'mp4',
                bitrate: 2000000,
                duration: postDuration || 30,
                url: videoUrl
            })])
        });
    }

    // If Kittygram gave us a thumbnail but no video (photo post), return PlatformPostDetails directly
    if (postThumbnail) {
        log('getContentDetails: photo post from Kittygram, returning PlatformPostDetails');
        var photoAuthorAvatar = authorThumb || platform.icon;
        return new PlatformPostDetails({
            id: new PlatformID(platform.title, shortcode, config.id),
            name: postTitle,
            author: new PlatformAuthorLink(
                new PlatformID(platform.title, authorName, config.id),
                authorName,
                API_URLS.base + '/' + encodeURIComponent(authorName) + '/',
                photoAuthorAvatar
            ),
            datetime: postDatetime,
            url: stringUrl,
            description: postDescription,
            images: [postThumbnail],
            textType: Type.Text.Raw,
            content: postDescription,
            thumbnails: new Thumbnails([new Thumbnail(postThumbnail, 0)]),
            rating: postLikes ? new RatingLikes(postLikes) : null
        });
    }

    // If no thumbnail either, try Instagram page (may hang for unauthenticated)
    // Kittygram had no video — try Instagram's own page (may hang for unauthenticated reels)
    // Ensure session is established before fetching page (sets cookies for richer page data)
    getSession();

    // Fetch the post page to determine content type and extract metadata
    var pageUrl = API_URLS.base + (isReel ? '/reel/' : '/p/') + shortcode + '/';
    var pageResp = http.GET(pageUrl, defaultHeaders(), false);

    if (pageResp && pageResp.isOk && pageResp.body) {
        var meta = extractMetaTags(pageResp.body);
        if (meta) {
            if (meta.title && meta.title !== 'Instagram') postTitle = meta.title;
            if (meta.description) postDescription = meta.description;
            if (meta.image) postThumbnail = meta.image;
        }
        // Try HTML regex fallback when OG meta has no thumbnail or had generic title
        if (!meta || !meta.image || meta.title === 'Instagram') {
            var htmlMeta = extractPostMetadataFromHtml(pageResp.body, shortcode);
            if (htmlMeta) {
                if (htmlMeta.title) postTitle = htmlMeta.title;
                if (htmlMeta.description) postDescription = htmlMeta.description;
                if (htmlMeta.thumbnail) postThumbnail = htmlMeta.thumbnail;
                if (htmlMeta.author) authorName = htmlMeta.author;
                if (htmlMeta.datetime) postDatetime = htmlMeta.datetime;
            }
        }

        // Extract author from og:title pattern or HTML metadata: "Author on Instagram: ..."
        var authorMatch = postTitle.match(/^([^|]+?)\s+on\s+Instagram/);
        if (authorMatch) authorName = authorMatch[1].trim();

        // Determine content type from og:type, LD+JSON, or URL
        var ogType = '';
        try {
            var doc = domParser.parseFromString(pageResp.body, 'text/html');
            var ogTypeMeta = doc.querySelector('meta[property="og:type"]');
            if (ogTypeMeta) ogType = ogTypeMeta.getAttribute('content') || '';
        } catch {}

        // Extract images and author info from LD+JSON (for both photo and video posts)
        var postImages = [];
        if (postThumbnail) postImages.push(postThumbnail);
        var ldVideoData = null;
        try {
            var ldDoc = domParser.parseFromString(pageResp.body, 'text/html');
            var ldScripts = ldDoc.querySelectorAll('script[type="application/ld+json"]');
            for (var si = 0; si < ldScripts.length; si++) {
                var ldData = JSON.parse(ldScripts[si].textContent);
                var ldItems = Array.isArray(ldData) ? ldData : [ldData];
                for (var li = 0; li < ldItems.length; li++) {
                    // Capture image objects
                    if (ldItems[li]['@type'] === 'ImageObject' && ldItems[li].contentUrl && postImages.indexOf(ldItems[li].contentUrl) === -1) {
                        postImages.push(ldItems[li].contentUrl);
                    }
                    // Capture author from any entity that has it
                    if (ldItems[li].author && ldItems[li].author.name) {
                        authorName = ldItems[li].author.name;
                    }
                    // Capture VideoObject data
                    if (ldItems[li]['@type'] === 'VideoObject' || (Array.isArray(ldItems[li]['@type']) && ldItems[li]['@type'].includes('VideoObject'))) {
                        ldVideoData = ldItems[li];
                    }
                }
            }
        } catch {}

        // Extract video author/timestamp/thumbnail from LD+JSON VideoObject
        if (ldVideoData) {
            if (ldVideoData.author && ldVideoData.author.name) authorName = ldVideoData.author.name;
            if (ldVideoData.uploadDate) {
                var ldDatetime = parseDatetimeToUnix(ldVideoData.uploadDate);
                if (ldDatetime) postDatetime = ldDatetime;
            }
            if (ldVideoData.thumbnailUrl && !postThumbnail) postThumbnail = ldVideoData.thumbnailUrl;
            if (ldVideoData.description && !postDescription) postDescription = ldVideoData.description;
        }
        log('getContentDetails: metadata for ' + shortcode + ' title=' + postTitle.substring(0, 40) + ' thumb=' + (postThumbnail ? postThumbnail.substring(0, 40) + '...' : 'none') + ' author=' + authorName);
    }

    log('getContentDetails: fetching videoUrl for ' + shortcode);
    videoUrl = fetchVideoUrl(shortcode);
    log('getContentDetails: fetchVideoUrl returned ' + (videoUrl ? 'url=' + videoUrl.substring(0, 40) + '...' : 'null'));

    // Fallback: try web_profile_info lookup if URL includes a username
    if (!videoUrl) {
        var usernameFromUrl = null;
        try {
            var pathSegments = pathname.split('/').filter(function(s) { return s.length > 0; });
            // Path segments: [username, "reel"|"p", shortcode] or ["reel"|"p", shortcode]
            if (pathSegments.length >= 3) {
                usernameFromUrl = pathSegments[0];
            }
        } catch {}
        if (usernameFromUrl) {
            try {
                var fbSession = getSession();
                if (fbSession.lsd && fbSession.mid) {
                    var profileData = fetchWebProfile(usernameFromUrl, fbSession);
                    if (profileData && profileData.data && profileData.data.user) {
                        var userObj = profileData.data.user;
                        var mediaSources = [
                            userObj.edge_owner_to_timeline_media,
                            userObj.edge_felix_video_timeline
                        ];
                        for (var si = 0; si < mediaSources.length && !videoUrl; si++) {
                            var conn = mediaSources[si];
                            if (conn && conn.edges) {
                                for (var ei = 0; ei < conn.edges.length; ei++) {
                                    var node = conn.edges[ei].node;
                                    if (node && node.shortcode === shortcode) {
                                        if (node.video_versions && node.video_versions.length > 0) {
                                            videoUrl = node.video_versions[0].url;
                                            videoUrlCache[shortcode] = videoUrl;
                                            feedItemCache[shortcode] = {
                                                code: shortcode,
                                                id: node.id,
                                                taken_at: node.taken_at_timestamp,
                                                video_versions: node.video_versions,
                                                image_versions2: node.thumbnail_resources ? { candidates: node.thumbnail_resources } : null,
                                                caption: node.edge_media_to_caption && node.edge_media_to_caption.edges && node.edge_media_to_caption.edges[0] ? { text: node.edge_media_to_caption.edges[0].node.text } : null,
                                                product_type: 'clips',
                                                video_duration: node.video_duration
                                            };
                                            if (node.owner && node.owner.username) authorName = node.owner.username;
                                            if (node.taken_at_timestamp) postDatetime = node.taken_at_timestamp;
                                            log('fetchVideoUrl: found via web_profile_info lookup for ' + usernameFromUrl);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                log('getContentDetails: web_profile_info fallback error: ' + e);
            }
        }
    }

    if (videoUrl) {
        // If metadata is still empty, try __a=1 page for richer embedded data (1.3MB with script tags)
        if (!postThumbnail || postThumbnail === platform.icon || postTitle === 'Instagram Post') {
            try {
                var a1Url = API_URLS.base + (isReel ? '/reel/' : '/p/') + shortcode + '/?__a=1';
                log('getContentDetails: retrying metadata via ' + a1Url);
                var a1Resp = http.GET(a1Url, defaultHeaders(), false);
                if (a1Resp && a1Resp.isOk && a1Resp.body) {
                    var a1Meta = extractPostMetadataFromHtml(a1Resp.body, shortcode);
                    if (a1Meta) {
                        if (a1Meta.title && (postTitle === 'Instagram Post' || !postTitle)) postTitle = a1Meta.title;
                        if (a1Meta.thumbnail && (!postThumbnail || postThumbnail === platform.icon)) postThumbnail = a1Meta.thumbnail;
                        if (a1Meta.author && authorName === 'Unknown') authorName = a1Meta.author;
                        if (a1Meta.datetime && !postDatetime) postDatetime = a1Meta.datetime;
                        if (a1Meta.description && !postDescription) postDescription = a1Meta.description;
                        log('getContentDetails: __a=1 metadata yielded thumb=' + (a1Meta.thumbnail ? a1Meta.thumbnail.substring(0, 40) + '...' : 'none'));
                    }
                }
            } catch (e) {
                log('getContentDetails: __a=1 metadata error: ' + e);
            }
        }

        var thumbUrl = postThumbnail || platform.icon;
        log('getContentDetails: video URL found, returning PlatformVideoDetails with thumb=' + thumbUrl.substring(0, 40) + '...');
        return new PlatformVideoDetails({
            id: new PlatformID(platform.title, shortcode, config.id),
            name: postTitle.substring(0, 100),
            thumbnails: new Thumbnails([new Thumbnail(thumbUrl, 0)]),
            author: new PlatformAuthorLink(
                new PlatformID(platform.title, authorName, config.id),
                authorName,
                API_URLS.base + '/' + encodeURIComponent(authorName) + '/',
                ''
            ),
            url: stringUrl,
            uploadDate: postDatetime,
            duration: null,
            description: postDescription,
            isLive: false,
            video: new VideoSourceDescriptor(
                [new VideoUrlSource({
                    width: 608,
                    height: 1080,
                    container: 'video/mp4',
                    codec: 'avc1.4d401e',
                    name: 'mp4',
                    bitrate: 2000000,
                    duration: 30,
                    url: videoUrl
                })]
            )
        });
    }

    log('getContentDetails: no video URL found, falling back to getPost');
    // getPost only matched /p/ URLs historically — normalise to /p/ so it always works
    var postFallbackUrl = API_URLS.base + '/p/' + shortcode + '/';
    return source.getPost(postFallbackUrl);
}

// Get photo post details
source.getPost = function (stringUrl) {
    log('getPost: ' + stringUrl);
    var parsedUrl = new URL(stringUrl);
    var pathname = parsedUrl.pathname.replace(/\/$/, '');
    var shortcode = null;
    var pMatch = pathname.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (pMatch) shortcode = pMatch[1];
    if (!shortcode) {
        var reelMatch2 = pathname.match(/\/reel\/([A-Za-z0-9_-]+)/);
        if (reelMatch2) shortcode = reelMatch2[1];
    }
    if (!shortcode)
        throw new ScriptException('Invalid Instagram post URL');

    // Ensure session is established before fetching page (sets cookies for richer page data)
    getSession();

    var pageUrl = API_URLS.base + '/p/' + shortcode + '/';
    var pageResp = http.GET(pageUrl, defaultHeaders(), false);
    var postTitle = 'Instagram Post';
    var postDescription = '';
    var postThumbnail = '';
    var authorName = 'Unknown';
    var postDatetime = null;
    var postImages = [];

    if (pageResp && pageResp.isOk && pageResp.body) {
        var meta = extractMetaTags(pageResp.body);
        if (meta) {
            if (meta.title && meta.title !== 'Instagram') postTitle = meta.title;
            if (meta.description) postDescription = meta.description;
            if (meta.image) postThumbnail = meta.image;
        }
        if (!meta || !meta.image || meta.title === 'Instagram') {
            var htmlMeta = extractPostMetadataFromHtml(pageResp.body, shortcode);
            if (htmlMeta) {
                if (htmlMeta.title) postTitle = htmlMeta.title;
                if (htmlMeta.description) postDescription = htmlMeta.description;
                if (htmlMeta.thumbnail) postThumbnail = htmlMeta.thumbnail;
                if (htmlMeta.author) authorName = htmlMeta.author;
                if (htmlMeta.datetime) postDatetime = htmlMeta.datetime;
            }
        }

        var authorMatch = postTitle.match(/^([^|]+?)\s+on\s+Instagram/);
        if (authorMatch) authorName = authorMatch[1].trim();

        if (postThumbnail) postImages.push(postThumbnail);

        try {
            var ldDoc = domParser.parseFromString(pageResp.body, 'text/html');
            var ldScripts = ldDoc.querySelectorAll('script[type="application/ld+json"]');
            for (var si = 0; si < ldScripts.length; si++) {
                var ldData = JSON.parse(ldScripts[si].textContent);
                var ldItems = Array.isArray(ldData) ? ldData : [ldData];
                for (var li = 0; li < ldItems.length; li++) {
                    if (ldItems[li]['@type'] === 'ImageObject' && ldItems[li].contentUrl && postImages.indexOf(ldItems[li].contentUrl) === -1) {
                        postImages.push(ldItems[li].contentUrl);
                        if (!postThumbnail) postThumbnail = ldItems[li].contentUrl;
                    }
                    if (ldItems[li].author && ldItems[li].author.name)
                        authorName = ldItems[li].author.name;
                    if ((ldItems[li]['@type'] === 'VideoObject' || (Array.isArray(ldItems[li]['@type']) && ldItems[li]['@type'].includes('VideoObject'))) && ldItems[li].thumbnailUrl && !postThumbnail)
                        postThumbnail = ldItems[li].thumbnailUrl;
                }
            }
        } catch {}
        log('getPost: metadata for ' + shortcode + ' title=' + postTitle.substring(0, 40) + ' images=' + postImages.length + ' thumb=' + (postThumbnail ? postThumbnail.substring(0, 40) + '...' : 'none') + ' author=' + authorName);
    }

    return new PlatformPostDetails({
        id: new PlatformID(platform.title, shortcode, config.id),
        name: postTitle.substring(0, 100),
        author: new PlatformAuthorLink(
            new PlatformID(platform.title, authorName, config.id),
            authorName,
            API_URLS.base + '/' + encodeURIComponent(authorName) + '/',
            ''
        ),
        datetime: postDatetime,
        url: stringUrl,
        description: postDescription,
        images: postImages,
        textType: Type.Text.Raw,
        content: postDescription,
        thumbnails: []
    });
}

// Get comments for a post
source.getComments = function (stringUrl) {
    log('getComments: ' + stringUrl);
    var parsedUrl = new URL(stringUrl);
    var pathname = parsedUrl.pathname.replace(/\/$/, '');
    var shortcode = null;
    var pMatch = pathname.match(/\/p\/([A-Za-z0-9_-]+)/);
    if (pMatch) shortcode = pMatch[1];
    if (!shortcode) {
        var reelMatch = pathname.match(/\/reel\/([A-Za-z0-9_-]+)/);
        if (reelMatch) shortcode = reelMatch[1];
    }
    if (!shortcode) {
        return new InstagramCommentPager([], false, { shortcode: null });
    }

    var kgHeaders = {
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'navigate'
    };

    var instances = getKittygramInstances();
    var foundComments = null;
    var videoDatetime = 0;
    instances.some(function(instance) {
        try {
            var url = instance + '/p/' + shortcode;
            log('getComments: trying ' + url);
            var resp = http.GET(url, kgHeaders, false);
            if (resp && resp.isOk && resp.body) {
                var postDoc = domParser.parseFromString(resp.body, 'text/html');
                var bodyText = postDoc.body ? postDoc.body.textContent : '';
                // Try datetime from cache first (populated by getChannelContents)
                if (datetimeCache[shortcode]) {
                    videoDatetime = datetimeCache[shortcode];
                    log('getComments: used datetimeCache for ' + shortcode + ' = ' + videoDatetime);
                }
                // Fall back to extracting from the post page
                if (!videoDatetime) {
                    var timeEl = postDoc.querySelector('time.post-time');
                    if (timeEl) {
                        var dtAttr = timeEl.getAttribute('datetime');
                        if (dtAttr) {
                            var parsed = parseDatetimeToUnix(dtAttr);
                            if (parsed !== null) {
                                videoDatetime = parsed;
                                log('getComments: extracted videoDatetime=' + videoDatetime + ' from datetime attr "' + dtAttr + '"');
                            }
                        }
                    }
                    if (!videoDatetime) {
                        // Fallback: scrape "Posted at: YYYY-MM-DD HH:MM:SS" from text
                        var timeMatch = bodyText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
                        if (timeMatch) {
                            var parsed2 = parseDatetimeToUnix(timeMatch[1] + ' ' + timeMatch[2]);
                            if (parsed2 !== null) {
                                videoDatetime = parsed2;
                                log('getComments: extracted videoDatetime=' + videoDatetime + ' from text fallback');
                            } else {
                                log('getComments: parseDatetimeToUnix returned null for "' + timeMatch[1] + ' ' + timeMatch[2] + '"');
                            }
                        } else {
                            log('getComments: no datetime found');
                        }
                    }
                }

                // Extract likes using domParser - look for "nil likes" or number
                var itemLikes = null;
                var likesEl = postDoc.querySelector('.post-likes');
                if (likesEl) {
                    var likesText = likesEl.textContent || '';
                    log('getComments: .post-likes text="' + likesText.trim() + '"');
                    if (likesText.toLowerCase().indexOf('nil') === -1) {
                        var likesMatch = likesText.match(/([\d,]+)/);
                        if (likesMatch) {
                            var likesNum = parseInt(likesMatch[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum)) itemLikes = likesNum;
                        }
                    }
                } else {
                    var bodyFullText = postDoc.body ? postDoc.body.textContent : '';
                    if (bodyFullText.toLowerCase().indexOf('nil likes') === -1) {
                        var likesMatch2 = bodyFullText.match(/([\d,]+)\s*likes?/i);
                        if (likesMatch2) {
                            var likesNum2 = parseInt(likesMatch2[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum2)) itemLikes = likesNum2;
                        }
                    }
                }
                log('getComments: extracted likes=' + itemLikes);
                var comments = parseKittygramPostPageComments(resp.body, shortcode, videoDatetime);
                log('getComments: found ' + comments.length + ' comments from ' + instance + ' with datetime=' + videoDatetime);
                foundComments = new InstagramCommentPager(comments, false, { shortcode: shortcode, instance: instance });
                return true;
            }
        } catch (e) {
            log('getComments: error: ' + e);
        }
        return false;
    });

    if (foundComments) return foundComments;
    log('getComments: no comments found, returning empty');
    showToast('Failed to load comments');
    return new InstagramCommentPager([], false, { shortcode: shortcode });
}

/**
 * Parses comments from Kittygram post page HTML.
 * @param {string} html - Post page HTML
 * @param {string} shortcode - Post shortcode
 * @param {number} videoDatetime - Video datetime (optional, defaults to 0)
 * @returns {Array} Array of PlatformComment
 */
function parseKittygramPostPageComments(html, shortcode, videoDatetime) {
    var comments = [];
    if (!videoDatetime) videoDatetime = 0;

    try {
        log('parseKittygramPostPageComments: html length=' + html.length);
        var doc = domParser.parseFromString(html, 'text/html');
        var commentArticles = doc.querySelectorAll('.comments article');
        log('parseKittygramPostPageComments: found ' + commentArticles.length + ' articles');

        commentArticles.forEach(function(article, idx) {
            var header = article.querySelector('.user-info');
            var avatarImg = header ? header.querySelector('img') : null;
            var authorLink = article.querySelector('a.username');
            var textEl = article.querySelector('p.comment-text');

            if (authorLink && textEl) {
                var author = authorLink.textContent.trim();
                var text = textEl.textContent.trim();
                var avatar = platform.icon;
                if (avatarImg) {
                    var avatarSrc = avatarImg.getAttribute('src');
                    if (avatarSrc) {
                        avatar = decodeKittygramProxy(avatarSrc);
                    }
                }

                if (author && text) {
                    comments.push(new PlatformComment({
                        id: new PlatformID(platform.title, shortcode + '_c' + idx, config.id),
                        author: new PlatformAuthorLink(
                            new PlatformID(platform.title, author, config.id),
                            author,
                            API_URLS.base + '/' + encodeURIComponent(author) + '/',
                            avatar
                        ),
                        message: text
                    }));
                }
            }
        });

        log('parseKittygramPostPageComments: parsed ' + comments.length + ' comments');
    } catch (e) {
        log('parseKittygramPostPageComments: error: ' + e);
    }

    return comments;
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

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parses a Kittygram search result card element into a PlatformChannel object.
 * @param {Element} card - A DOM element with class .user-info.item-card.search-result
 * @returns {PlatformChannel|null} A PlatformChannel if parsing succeeds, or null if required fields are missing
 */
function parseChannelFromCard(card) {
    var usernameLink = card.querySelector('a.username');
    var avatarImg = card.querySelector('img');
    if (!usernameLink) return null;
    var username = usernameLink.getAttribute('href').replace('/', '');
    var avatar = platform.icon;
    if (avatarImg) {
        var src = avatarImg.getAttribute('src');
        if (src) avatar = decodeKittygramProxy(src);
    }
    return new PlatformChannel({
        id: new PlatformID(platform.title, username, config.id),
        name: username,
        thumbnail: avatar,
        banner: avatar,
        subscribers: 0,
        description: '',
        url: API_URLS.base + '/' + encodeURIComponent(username) + '/',
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
    var kgHeaders = {
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'navigate'
    };
    var instances = getKittygramInstances();
    var channels = [];

    instances.some(function(instance) {
        try {
            var url = instance + '/search?q=' + encodeURIComponent(query);
            log('searchKittygramChannels: trying ' + url);
            var resp = http.GET(url, kgHeaders, false);
            if (resp && resp.isOk && resp.body) {
                var doc = domParser.parseFromString(resp.body, 'text/html');
                var userCards = doc.querySelectorAll('.user-info.item-card.search-result');
                userCards.forEach(function(card) {
                    var ch = parseChannelFromCard(card);
                    if (ch) channels.push(ch);
                });
                log('searchKittygramChannels: found ' + channels.length + ' results from ' + instance);
                if (channels.length > 0) return true;
            }
        } catch (e) {
            log('searchKittygramChannels: error: ' + e);
        }
        return false;
    });

    return channels;
}

function getKittygramInstanceUrl(idx) {
    if (idx >= 0 && idx < KITTYGRAM_INSTANCES.length) {
        return KITTYGRAM_INSTANCES[idx];
    }
    return KITTYGRAM_INSTANCES[0];
}

function getKittygramInstances() {
    var preferredIdx = 0;
    try {
        if (settings && settings.kittygramInstance !== undefined) {
            preferredIdx = parseInt(settings.kittygramInstance, 10);
            if (isNaN(preferredIdx)) preferredIdx = 0;
        }
    } catch {}
    var preferred = getKittygramInstanceUrl(preferredIdx);
    var rest = KITTYGRAM_INSTANCES[0] === preferred
        ? KITTYGRAM_INSTANCES.slice(1)
        : KITTYGRAM_INSTANCES.filter(function(i) { return i !== preferred; });
    return [preferred].concat(rest);
}

function getPreferredKittygramInstance() {
    var preferredIdx = 0;
    try {
        if (settings && settings.kittygramInstance !== undefined) {
            preferredIdx = parseInt(settings.kittygramInstance, 10);
            if (isNaN(preferredIdx)) preferredIdx = 0;
        }
    } catch {}
    return getKittygramInstanceUrl(preferredIdx);
}

function shouldUseInstagramShareUrl() {
    try {
        if (settings && settings.useInstagramUrlsForSharing !== undefined) {
            return settings.useInstagramUrlsForSharing === true;
        }
    } catch {}
    return false;
}

function getShareUrl(shortcode, isVideo) {
    if (shouldUseInstagramShareUrl()) {
        return API_URLS.base + (isVideo ? '/reel/' : '/p/') + shortcode + '/';
    }
    var preferredInstance = getPreferredKittygramInstance();
    return preferredInstance + (isVideo ? '/reel/' : '/p/') + shortcode;
}

function getChannelContentPager(url, type, order, filters, continuationToken, query) {
    var username = extractUsername(url);
    if (!username) return new VideoPager([], false);

    var wantShorts = (type === Type.Feed.Shorts);
    var queryLower = query ? query.toLowerCase() : null;

    log('getChannelContents: fetching page for ' + username);
    const response = http.GET(API_URLS.base + '/' + encodeURIComponent(username) + '/', defaultHeaders(), false);
    if (!response || !response.isOk) {
        log('getChannelContents: HTTP ' + (response ? response.code : 'no response'));
        return new VideoPager([], false);
    }

    log('getChannelContents: response length=' + response.body.length);

    if (!lsdToken || !midCookie) {
        var profileLsd = extractLsdToken(response.body);
        if (profileLsd) lsdToken = profileLsd;
    }
    if (response && response.headers) {
        var sc = response.headers['Set-Cookie'] || response.headers['set-cookie'];
        if (sc) {
            var parsedCookies = parseSetCookies(sc);
            if (parsedCookies.cookieHeader && !cookieStore) cookieStore = parsedCookies.cookieHeader;
            if (parsedCookies.valid.mid) midCookie = parsedCookies.valid.mid;
        }
    }

    var profileThumbnail = platform.icon;
    var meta = extractMetaTags(response.body);
    if (meta && meta.image) profileThumbnail = meta.image;
    try {
        var htmlChannelMeta = extractChannelMetadataFromHtml(response.body, username);
        if (htmlChannelMeta && htmlChannelMeta.thumbnail) profileThumbnail = htmlChannelMeta.thumbnail;
    } catch {}
    if (!profileThumbnail || profileThumbnail === platform.icon) {
        try {
            var ldProf = extractLdProfile(response.body);
            if (ldProf && ldProf.user && ldProf.user.image) profileThumbnail = ldProf.user.image;
        } catch {}
    }
    if (!profileThumbnail || profileThumbnail === platform.icon) {
        try {
            var session = getSession();
            if (session.lsd && session.mid) {
                var pd = fetchWebProfile(username, session);
                if (pd && pd.data && pd.data.user) {
                    profileThumbnail = pd.data.user.profile_pic_url_hd || pd.data.user.profile_pic_url || profileThumbnail;
                }
            }
        } catch {}
    }

    var kgResult = null;
    var isKittygramCursor = continuationToken && typeof continuationToken === 'string' && continuationToken.indexOf('kg_') === 0;
    if (!continuationToken || isKittygramCursor) {
        var kgCursor = isKittygramCursor ? continuationToken.substring(3) : null;
        log('getChannelContents: trying Kittygram with cursor=' + (kgCursor || 'null'));
        kgResult = fetchFromKittygram(username, kgCursor);
    }

    var videos = [];
    var seen = {};
    var items = null;
    var hasMore = false;
    var nextCursor = null;

    if (kgResult && kgResult.items && kgResult.items.length > 0) {
        log('getChannelContents: using Kittygram result with ' + kgResult.items.length + ' items, hasMore=' + kgResult.hasMore);
        items = kgResult.items;
        hasMore = kgResult.hasMore || false;
        nextCursor = kgResult.nextCursor ? 'kg_' + kgResult.nextCursor : null;
        if (kgResult.profile && kgResult.profile.thumbnail && (!profileThumbnail || profileThumbnail === platform.icon)) {
            profileThumbnail = kgResult.profile.thumbnail;
        }
    } else {
        log('getChannelContents: Kittygram returned nothing, trying Instagram API');
        var feedResult = fetchFeedItems(username, continuationToken);
        items = feedResult ? feedResult.items : null;
        hasMore = feedResult ? feedResult.hasMore : false;
        nextCursor = feedResult ? feedResult.nextCursor : null;
    }

    var isHtmlFallback = false;
    if (!items || items.length === 0) {
        var htmlShortcodes = extractShortcodes(response.body);
        if (htmlShortcodes && htmlShortcodes.length > 0) {
            items = [];
            for (var si = 0; si < htmlShortcodes.length; si++) items.push({ code: htmlShortcodes[si] });
            isHtmlFallback = true;
        }
    }

    if (!items || items.length === 0) {
        try {
            var fbSession = getSession();
            if (fbSession.lsd) {
                var a1Url = API_URLS.base + '/' + encodeURIComponent(username) + '/?__a=1';
                var a1Headers = apiHeaders(fbSession.lsd, fbSession.mid || '');
                a1Headers['Referer'] = url;
                a1Headers['Accept'] = 'application/json';
                var a1Resp = http.GET(a1Url, a1Headers, false);
                if (a1Resp && a1Resp.isOk && a1Resp.body) {
                    var a1Data = tryParse(a1Resp.body);
                    if (a1Data && a1Data.graphql && a1Data.graphql.user) {
                        var userEdge = a1Data.graphql.user.edge_owner_to_timeline_media;
                        if (userEdge && userEdge.edges) {
                            items = [];
                            for (var ei = 0; ei < userEdge.edges.length; ei++) {
                                var edge = userEdge.edges[ei];
                                if (edge.node && edge.node.shortcode) {
                                    var isReel = edge.node.media_type === 2 || edge.node.product_type === 'clips' || edge.node.__typename === 'XDTGraphVideo';
                                    var isVid = edge.node.is_video || (edge.node.video_versions && edge.node.video_versions.length > 0) || edge.node.video_duration;
                                    items.push({ code: edge.node.shortcode, id: edge.node.id, taken_at: edge.node.taken_at_timestamp, video_versions: edge.node.video_versions || null, image_versions2: edge.node.thumbnail_resources ? { candidates: edge.node.thumbnail_resources } : null, display_url: edge.node.display_url || null, thumbnail_src: edge.node.thumbnail_src || null, thumbnail_resources: edge.node.thumbnail_resources || null, caption: edge.node.edge_media_to_caption && edge.node.edge_media_to_caption.edges && edge.node.edge_media_to_caption.edges[0] ? { text: edge.node.edge_media_to_caption.edges[0].node.text } : null, product_type: isReel ? 'clips' : (isVid ? 'feed' : null), video_duration: edge.node.video_duration || null });
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) { log('getChannelContents: __a=1 error: ' + e); }
    }

    if (!items || items.length === 0) {
        try {
            var disUrl = API_URLS.base + '/' + encodeURIComponent(username) + '/?__a=1&__d=dis';
            var disHeaders = defaultHeaders();
            disHeaders['Accept'] = 'application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
            var disResp = http.GET(disUrl, disHeaders, false);
            if (disResp && disResp.isOk && disResp.body) {
                var disData = tryParse(disResp.body);
                if (disData) {
                    var graphUser = null;
                    try { graphUser = disData.graphql && disData.graphql.user; } catch {}
                    try { if (!graphUser) graphUser = disData.data && disData.data.user; } catch {}
                    if (graphUser) {
                        var sources = [graphUser.edge_owner_to_timeline_media, graphUser.edge_felix_video_timeline];
                        for (var si2 = 0; si2 < sources.length && (!items || items.length === 0); si2++) {
                            var conn = sources[si2];
                            if (conn && conn.edges && conn.edges.length > 0) {
                                items = [];
                                for (var ei2 = 0; ei2 < conn.edges.length; ei2++) {
                                    var node = conn.edges[ei2].node;
                                    if (!node || !node.shortcode) continue;
                                    var isReel2 = node.media_type === 2 || node.product_type === 'clips' || node.__typename === 'XDTGraphVideo';
                                    var isVid2 = node.is_video || (node.video_versions && node.video_versions.length > 0) || node.video_duration;
                                    items.push({ code: node.shortcode, id: node.id, taken_at: node.taken_at_timestamp, video_versions: node.video_versions || null, image_versions2: node.thumbnail_resources ? { candidates: node.thumbnail_resources } : null, caption: node.edge_media_to_caption && node.edge_media_to_caption.edges && node.edge_media_to_caption.edges[0] ? { text: node.edge_media_to_caption.edges[0].node.text } : null, product_type: isReel2 ? 'clips' : (isVid2 ? 'feed' : null), video_duration: node.video_duration || null });
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) { log('getChannelContents: __a=1&__d=dis error: ' + e); }
    }

    if (!items || items.length === 0) {
        try {
            var a1bUrl = API_URLS.base + '/' + encodeURIComponent(username) + '/?__a=1';
            var a1bHeaders = defaultHeaders();
            a1bHeaders['Accept'] = 'application/json,text/html,*/*';
            var a1bResp = http.GET(a1bUrl, a1bHeaders, false);
            if (a1bResp && a1bResp.isOk && a1bResp.body) {
                var a1bData = tryParse(a1bResp.body);
                if (a1bData && a1bData.graphql && a1bData.graphql.user) {
                    var userEdge2 = a1bData.graphql.user.edge_owner_to_timeline_media;
                    if (userEdge2 && userEdge2.edges) {
                        items = [];
                        for (var ei3 = 0; ei3 < userEdge2.edges.length; ei3++) {
                            var edge3 = userEdge2.edges[ei3];
                            if (edge3.node && edge3.node.shortcode) {
                                items.push({ code: edge3.node.shortcode, id: edge3.node.id, taken_at: edge3.node.taken_at_timestamp, video_versions: edge3.node.video_versions || null, image_versions2: edge3.node.thumbnail_resources ? { candidates: edge3.node.thumbnail_resources } : null, display_url: edge3.node.display_url || null, thumbnail_src: edge3.node.thumbnail_src || null, thumbnail_resources: edge3.node.thumbnail_resources || null, caption: edge3.node.edge_media_to_caption && edge3.node.edge_media_to_caption.edges && edge3.node.edge_media_to_caption.edges[0] ? { text: edge3.node.edge_media_to_caption.edges[0].node.text } : null, product_type: (edge3.node.media_type === 2 || edge3.node.product_type === 'clips') ? 'clips' : (edge3.node.is_video || edge3.node.video_duration ? 'feed' : null), video_duration: edge3.node.video_duration || null });
                            }
                        }
                    }
                }
            }
        } catch (e) { log('getChannelContents: __a=1 browser error: ' + e); }
    }

    if (!items || items.length === 0) {
        var kgFallback = fetchFromKittygram(username);
        if (kgFallback && kgFallback.items && kgFallback.items.length > 0) {
            items = kgFallback.items;
            if (kgFallback.profile && kgFallback.profile.thumbnail && (!profileThumbnail || profileThumbnail === platform.icon))
                profileThumbnail = kgFallback.profile.thumbnail;
        }
    }

    if (items) {
        for (var fi = 0; fi < items.length; fi++) {
            var item = items[fi];
            var sc = item.code || item.id;
            if (!sc || seen[sc]) continue;
            seen[sc] = true;

            var isVideo = false;
            try { isVideo = item.isVideo || item.videoUrl || item.product_type === 'clips' || item.product_type === 'feed' || (item.video_versions && item.video_versions.length > 0) || item.video_duration; } catch {}
            if (wantShorts && !isVideo && !isHtmlFallback) continue;

            if (item.videoUrl) videoUrlCache[sc] = item.videoUrl;
            else if (item.video_versions && item.video_versions.length > 0) videoUrlCache[sc] = item.video_versions[0].url;
            feedItemCache[sc] = item;

            var title = 'Instagram Post';
            var itemCaption = null;
            try { itemCaption = item.caption && (item.caption.text || item.caption); } catch {}
            if (itemCaption && itemCaption !== '') title = itemCaption.substring(0, 100);

            var itemThumb = profileThumbnail;
            try { if (item.thumbnail && item.thumbnail !== profileThumbnail) itemThumb = item.thumbnail; } catch {}
            try { var versions = item.image_versions2 && item.image_versions2.candidates; if (versions && versions.length > 0) itemThumb = versions[0].url || versions[0].src || itemThumb; } catch {}
            try { if (item.display_url && (!itemThumb || itemThumb === profileThumbnail)) itemThumb = item.display_url; } catch {}
            try { if (item.thumbnail_src && (!itemThumb || itemThumb === profileThumbnail)) itemThumb = item.thumbnail_src; } catch {}
            try { if (item.thumbnail_resources && item.thumbnail_resources.length > 0 && (!itemThumb || itemThumb === profileThumbnail)) itemThumb = item.thumbnail_resources[0].url || item.thumbnail_resources[0].src || itemThumb; } catch {}
            if (!itemThumb || itemThumb === platform.icon) {
                try { var scThumb = extractPostMetadataFromHtml(response.body, sc); if (scThumb && scThumb.thumbnail) itemThumb = scThumb.thumbnail; } catch {}
            }
            log('getChannelContents: video ' + sc + ' thumb=' + (itemThumb ? itemThumb.substring(0, 50) + '...' : 'none'));
            if (itemThumb && itemThumb !== platform.icon) thumbnailCache[sc] = itemThumb;
            if (item.likes) likesCache[sc] = item.likes;
            if (item.taken_at) datetimeCache[sc] = item.taken_at;

            var duration = null;
            try { if (item.video_duration) { duration = Math.round(item.video_duration); log('getChannelContents: video_duration=' + item.video_duration + ' -> duration=' + duration); } } catch {}
            try { if (item.duration && !duration) { duration = Math.round(item.duration); log('getChannelContents: duration (Kittygram)=' + item.duration + ' -> duration=' + duration); } } catch {}

            var datetime = null;
            try { if (item.taken_at) datetime = item.taken_at; } catch {}

            var postUrl = API_URLS.base + (isVideo ? '/reel/' : '/p/') + sc + '/';
            var shareUrl = getShareUrl(sc, isVideo);
            var itemLikes = null;
            try { if (item.likes) itemLikes = item.likes; } catch {}

            var entry = isVideo ? new PlatformVideo({
                id: new PlatformID(platform.title, sc, config.id),
                name: title,
                thumbnails: new Thumbnails([new Thumbnail(itemThumb, 0)]),
                author: new PlatformAuthorLink(new PlatformID(platform.title, username, config.id), username, url, profileThumbnail),
                datetime: datetime,
                duration: duration,
                viewCount: itemLikes,
                url: postUrl,
                shareUrl: shareUrl,
                isLive: false,
                rating: itemLikes ? new RatingLikes(itemLikes) : null
            }) : new PlatformPostDetails({
                id: new PlatformID(platform.title, sc, config.id),
                name: title,
                author: new PlatformAuthorLink(new PlatformID(platform.title, username, config.id), username, url, profileThumbnail),
                datetime: datetime,
                url: postUrl,
                description: itemCaption || '',
                images: itemThumb ? [itemThumb] : [],
                textType: Type.Text.Raw,
                content: itemCaption || '',
                thumbnails: [],
                rating: itemLikes ? new RatingLikes(itemLikes) : null
            });

            if (queryLower) {
                var searchText = (title + ' ' + (itemCaption || '')).toLowerCase();
                if (searchText.indexOf(queryLower) === -1) continue;
            }

            videos.push(entry);
        }
    }

    log('getChannelContentPager: returning pager with ' + videos.length + ' videos');
    return new InstagramVideoPager(videos, hasMore && !!nextCursor, { username: username, cursor: nextCursor, wantShorts: wantShorts });
}

function showToast(message) {
    try {
        if (typeof bridge !== 'undefined' && bridge.toast) {
            bridge.toast(message);
        }
    } catch {}
}

/**
 * Builds common HTTP headers for Instagram requests
 * @returns {Object} Headers object
 */
/**
 * Parses a raw Set-Cookie header value (single string or array) and returns
 * a cleaned Cookie: header string containing only valid (non-deleted) cookies.
 * Returns an object {cookieHeader, mid, csrftoken} for callers that need the
 * cookie header and key cookies for further use.
 * @param {string|string[]} setCookie - Raw Set-Cookie header value
 * @returns {{cookieHeader: string, valid: Object}}
 */
function parseSetCookies(setCookie) {
    var cookieStr = Array.isArray(setCookie) ? setCookie.join(', ') : setCookie;
    var validCookies = {};
    if (!cookieStr) return { cookieHeader: '', valid: validCookies };
    // Split on commas that precede a cookie-name=value pattern (handles multi-cookie strings)
    var cookieEntries = cookieStr.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_-]*\s*=)/);
    for (var ci = 0; ci < cookieEntries.length; ci++) {
        var entry = cookieEntries[ci].trim();
        if (!entry) continue;
        var firstSemi = entry.indexOf(';');
        var nameValue = firstSemi === -1 ? entry : entry.substring(0, firstSemi);
        var eqIdx = nameValue.indexOf('=');
        if (eqIdx === -1) continue;
        var name = nameValue.substring(0, eqIdx).trim();
        var value = nameValue.substring(eqIdx + 1).trim();
        // Skip cookies that were marked as deleted by Instagram
        if (value === 'deleted' || value === '""' || value === '') continue;
        var attrs = firstSemi === -1 ? '' : entry.substring(firstSemi);
        if (/expires\s*=\s*Thu,\s*01-Jan-1970/i.test(attrs)) continue;
        if (/Max-Age\s*=\s*-/i.test(attrs)) continue;
        validCookies[name] = value;
    }
    var cookieParts = [];
    var keys = Object.keys(validCookies);
    for (var ki = 0; ki < keys.length; ki++) {
        cookieParts.push(keys[ki] + '=' + validCookies[keys[ki]]);
    }
    return { cookieHeader: cookieParts.join('; '), valid: validCookies };
}

function defaultHeaders() {
    var h = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': API_URLS.base + '/',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    };
    if (cookieStore) h['Cookie'] = cookieStore;
    return h;
}

/**
 * Builds headers for API requests that include LSD token and app ID.
 * Modern Instagram uses LSD instead of csrftoken for logged-out GraphQL requests.
 * @param {string} lsdToken - LSD token from the page HTML
 * @param {string} mid - Mid cookie value
 * @returns {Object} Headers object for API calls
 */
function apiHeaders(lsdToken, mid) {
    var headers = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'x-ig-app-id': IG_APP_ID,
        'x-fb-lsd': lsdToken || '',
        'x-requested-with': 'XMLHttpRequest',
        'Referer': API_URLS.base + '/',
        'Origin': API_URLS.base
    };
    // Include all captured cookies
    if (cookieStore) {
        headers['Cookie'] = cookieStore;
        // Extract csrftoken from cookieStore and add as x-csrftoken header (Instagram expects this)
        var csrfMatch = cookieStore.match(/csrftoken=([^;]+)/);
        if (csrfMatch) headers['x-csrftoken'] = csrfMatch[1];
    } else if (mid) {
        headers['Cookie'] = 'mid=' + mid + ';';
    }
    return headers;
}

/**
 * Extracts the mid (device ID) value from HTML body as fallback when Set-Cookie is missing.
 * Searches for mid in embedded JSON or JavaScript patterns.
 * @param {string} html - Page HTML
 * @returns {string|null} Mid value, or null
 */
function extractMidFromBody(html) {
    if (!html) return null;
    try {
        // Pattern: "mid":"ABC123"
        var m1 = html.match(/["']mid["']\s*:\s*["']([a-zA-Z0-9_-]{10,})["']/);
        if (m1 && m1[1] && m1[1] !== 'null') return m1[1];
        // Pattern: mid: "ABC123" (JavaScript object)
        var m2 = html.match(/mid\s*:\s*["']([a-zA-Z0-9_-]{10,})["']/);
        if (m2 && m2[1] && m2[1] !== 'null') return m2[1];
        return null;
    } catch {
        return null;
    }
}

/**
 * Extracts the LSD (Login Status Data) token from Instagram's page HTML.
 * Uses multiple regex patterns to find the token in various formats.
 * @param {string} html - Page HTML to search for the token
 * @returns {string|null} LSD token value, or null
 */
function extractLsdToken(html) {
    if (!html) return null;
    try {
        // Search for "lsd" anywhere in the page and log surrounding context
        var lsdIdx = html.indexOf('"lsd"');
        if (lsdIdx === -1) lsdIdx = html.indexOf("'lsd'");
        if (lsdIdx === -1) lsdIdx = html.indexOf('LSD');
        if (lsdIdx !== -1) {
            var ctx = html.substring(Math.max(0, lsdIdx - 30), lsdIdx + 100);
            log('extractLsdToken: found "lsd" at ' + lsdIdx + ' context=' + ctx.substring(0, 130));
        } else {
            log('extractLsdToken: "lsd" not found in HTML');
            return null;
        }

        // Diagnostic: check for canonical ["LSD" array format presence
        var lsdArrIdx = html.indexOf('["LSD"');
        if (lsdArrIdx !== -1) {
            var arrCtx = html.substring(lsdArrIdx, lsdArrIdx + 150);
            log('extractLsdToken: found ["LSD"] array at ' + lsdArrIdx + ' context=' + arrCtx.substring(0, 130));
        }

        // Pattern A (NEW, canonical Meta format): ["LSD",[deps],{"token":"VALUE"},###]
        // This is the modern Polaris/Comet bundle format and is the most reliable.
        var mA = html.match(/\["LSD"\s*,\s*\[[^\]]*\]\s*,\s*\{[^}]*?["']token["']\s*:\s*["']([^"']+)/);
        if (mA && mA[1] && mA[1] !== 'null') {
            log('extractLsdToken: matched pattern A (canonical Meta array)');
            return mA[1];
        }

        // Pattern 1: {"lsd":{"token":"ABC123"}}
        var m1 = html.match(/["']lsd["']\s*:\s*\{[^}]*?["']token["']\s*:\s*["']([^"']+)/i);
        if (m1 && m1[1] !== 'null') { log('extractLsdToken: matched pattern 1'); return m1[1]; }

        // Pattern 2: "LSD":["ABC123"]
        var m2 = html.match(/["']LSD["']\s*:\s*\[["']([^"']+)/);
        if (m2 && m2[1] !== 'null') { log('extractLsdToken: matched pattern 2'); return m2[1]; }

        // Pattern 3: LSD.token = "ABC123"
        var m3 = html.match(/LSD\s*\.\s*token\s*=\s*["']([^"']+)/);
        if (m3 && m3[1] !== 'null') { log('extractLsdToken: matched pattern 3'); return m3[1]; }

        // Pattern 4: __d("LSD",[],function(n){return "ABC123"})
        var m4 = html.match(/__d\s*\(\s*["']LSD["'][\s\S]*?return\s+["']([^"']+)/);
        if (m4 && m4[1] !== 'null') { log('extractLsdToken: matched pattern 4'); return m4[1]; }

        // Pattern 5: LSD={"token":"ABC123"}
        var m5 = html.match(/LSD\s*=\s*["']?\{[^}]*?["']token["']\s*:\s*["']([^"']+)/);
        if (m5 && m5[1] !== 'null') { log('extractLsdToken: matched pattern 5'); return m5[1]; }

        // Pattern 6: "lsd":"ABC123" — iterate through ALL occurrences with global flag,
        // because the FIRST `"lsd"` in the HTML may be `"lsd":null` (login form config).
        // No /i flag: uppercase "LSD" was a different format we already handled in patterns 2/A.
        var m6Regex = /["']lsd["']\s*:\s*["']([^"'},\s]+)["']/g;
        var m6;
        while ((m6 = m6Regex.exec(html)) !== null) {
            if (m6[1] && m6[1].length > 0 && m6[1] !== 'null') {
                log('extractLsdToken: matched pattern 6 at offset ' + m6.index);
                return m6[1];
            }
        }

        // Pattern 7: Windowed search around the first lowercase "lsd" occurrence
        if (lsdIdx !== -1) {
            var windowStr = html.substring(lsdIdx, lsdIdx + 200);
            var wMatch = windowStr.match(/["']lsd["']\s*:\s*["']([^"'},\s]+)/);
            if (wMatch && wMatch[1].length > 0 && wMatch[1] !== 'null') {
                log('extractLsdToken: matched pattern 7 (windowed)');
                return wMatch[1];
            }
        }

        // Pattern 8: "\"lsd\":\"ABC123\"" (escaped quotes inside JavaScript strings)
        var m8 = html.match(/\\"lsd\\"\s*:\s*\\"([^"\\]+)/);
        if (m8 && m8[1].length > 0 && m8[1] !== 'null') {
            log('extractLsdToken: matched pattern 8 (escaped)');
            return m8[1];
        }

        log('extractLsdToken: no patterns matched');
        return null;
    } catch (e) {
        log('extractLsdToken: error: ' + e);
        return null;
    }
}

/**
 * Generates a random mid (device ID) value for requests when server doesn't provide one.
 * Uses an 'ags' prefix pattern matching real Instagram mids.
 * @returns {string} Random mid string
 */
function generateMid() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var result = 'ags';
    for (var i = 0; i < 14; i++) {
        result += chars.charAt(Math.floor(Math.random() * 64));
    }
    return result;
}

/**
 * Fetches the mid cookie and LSD token from Instagram's homepage.
 * If LSD is not found on the homepage, tries a profile page that is known to contain it.
 * The mid cookie identifies the device/session; the LSD token is used for CSRF.
 * Caches results in global variables for reuse across requests.
 * @returns {{lsd: string|null, mid: string|null}} Session tokens
 */
function getSession() {
    if (lsdToken && midCookie) {
        log('getSession: using cached session');
        return { lsd: lsdToken, mid: midCookie };
    }

    try {
        log('getSession: fetching homepage');
        var cacheBuster = '?_=' + new Date().getTime();
        var resp = http.GET(API_URLS.base + cacheBuster, defaultHeaders(), false);

        // Extract ALL cookies from Set-Cookie headers, filtering out deleted/expired ones
        if (resp && resp.headers) {
            var setCookie = resp.headers['Set-Cookie'] || resp.headers['set-cookie'] || resp.headers['Set-cookie'];
            if (setCookie) {
                var parsed = parseSetCookies(setCookie);
                if (parsed.cookieHeader) cookieStore = parsed.cookieHeader;
                if (parsed.valid.mid) {
                    midCookie = parsed.valid.mid;
                    log('getSession: found mid=' + midCookie.substring(0, 10) + '...');
                }
                log('getSession: captured ' + Object.keys(parsed.valid).length + ' valid cookies: ' + cookieStore.substring(0, 200));
            }
        }

        // Search for LSD token in the homepage body
        if (resp && resp.body) {
            lsdToken = extractLsdToken(resp.body);
            if (lsdToken) log('getSession: found lsd on homepage=' + lsdToken.substring(0, 10) + '...');
        }

        // If LSD not found on homepage, try fetching from a profile page
        if (!lsdToken) {
            log('getSession: homepage has no LSD, fetching a profile page');
            try {
                var profileResp = http.GET(API_URLS.base + '/instagram/', defaultHeaders(), false);
                if (profileResp && profileResp.isOk && profileResp.body) {
                    lsdToken = extractLsdToken(profileResp.body);
                    if (lsdToken) log('getSession: found lsd on /instagram/ page=' + lsdToken.substring(0, 10) + '...');
                }
            } catch (e2) {
                log('getSession: profile page error: ' + e2);
            }
        }

        // Generate random mid if server didn't provide one
        if (!midCookie) {
            midCookie = generateMid();
            log('getSession: generated mid=' + midCookie.substring(0, 10) + '...');
        }

        if (lsdToken) {
            log('getSession: session established');
            return { lsd: lsdToken, mid: midCookie };
        }

        log('getSession: incomplete - lsd=' + (!!lsdToken) + ' mid=' + (!!midCookie));
        return { lsd: lsdToken, mid: midCookie };
    } catch (e) {
        log('getSession: error: ' + e);
        return { lsd: null, mid: null };
    }
}

/**
 * Builds alternative headers for API requests using a fallback app ID.
 * Used when the primary IG_APP_ID returns 401.
 * @param {string} lsdToken - LSD token from the page HTML
 * @param {string} mid - Mid cookie value
 * @returns {Object} Headers object for API calls
 */
function apiHeadersAlt(lsdToken, mid) {
    var headers = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'x-ig-app-id': IG_APP_ID_ALT,
        'x-fb-lsd': lsdToken || '',
        'x-requested-with': 'XMLHttpRequest',
        'Referer': API_URLS.base + '/',
        'Origin': API_URLS.base
    };
    if (cookieStore) {
        headers['Cookie'] = cookieStore;
        var csrfMatch = cookieStore.match(/csrftoken=([^;]+)/);
        if (csrfMatch) headers['x-csrftoken'] = csrfMatch[1];
    } else if (mid) {
        headers['Cookie'] = 'mid=' + mid + ';';
    }
    return headers;
}

/**
 * Fetches user profile info via Instagram's web API (web_profile_info endpoint).
 * Tries both app IDs and falls back to POST if GET fails with 401.
 * Clears stale session and caches on 401 (rate limited).
 * @param {string} username - Instagram username
 * @param {Object} session - Session object with lsd and mid
 * @returns {Object|null} Parsed JSON response, or null
 */
function fetchWebProfile(username, session) {
    var url = API_URLS.base + '/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username);
    log('fetchWebProfile: url=' + url);
    var appIdsToTry = [IG_APP_ID, IG_APP_ID_ALT];
    for (var ai = 0; ai < appIdsToTry.length; ai++) {
        var headers = (appIdsToTry[ai] === IG_APP_ID)
            ? apiHeaders(session.lsd, session.mid)
            : apiHeadersAlt(session.lsd, session.mid);
        try {
            log('fetchWebProfile: trying GET with appId=' + appIdsToTry[ai].substring(0, 6) + '...');
            var resp = http.GET(url, headers, false);
            if (resp && resp.body) {
                log('fetchWebProfile: GET code=' + resp.code + ' length=' + resp.body.length);
                if (resp.code === 401) {
                    log('fetchWebProfile: 401, will try next app ID');
                    continue;
                }
                if (resp.isOk) {
                    var parsed = tryParse(resp.body);
                    if (parsed) {
                        log('fetchWebProfile: keys=' + Object.keys(parsed).join(', '));
                        if (parsed.data && parsed.data.user) {
                            log('fetchWebProfile: user keys=' + Object.keys(parsed.data.user).join(', '));
                        }
                        return parsed;
                    }
                }
                if (resp.body) log('fetchWebProfile: GET first 200=' + resp.body.substring(0, 200));
            }
        } catch (e) {
            log('fetchWebProfile: GET error with appId=' + appIdsToTry[ai].substring(0, 6) + '...: ' + e);
        }
    }

    // NOTE: Don't clear session on 401 — web_profile_info requires login sessionid cookie
    // in 2024+. The LSD token may still be valid for other endpoints (HTML fetch, etc.).
    // Clearing here just wastes time on a re-auth cycle.

    // Try POST request with primary app ID
    try {
        var postHeaders = apiHeaders(session.lsd, session.mid);
        postHeaders['Referer'] = API_URLS.base + '/' + encodeURIComponent(username) + '/';
        postHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        log('fetchWebProfile: trying POST');
        var resp = http.POST(url, '', postHeaders, false);
        if (resp && resp.body) {
            log('fetchWebProfile: POST code=' + resp.code + ' length=' + resp.body.length);
            if (resp.isOk) {
                var parsed = tryParse(resp.body);
                if (parsed) return parsed;
            }
        }
    } catch (e) {
        log('fetchWebProfile: POST error: ' + e);
    }

    log('fetchWebProfile: failed');
    return null;
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
    var kgHeaders = {
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'navigate'
    };
    var instances = getKittygramInstances();

    var result = null;
    var failedInstance = null;
    instances.some(function(instance) {
        try {
            var url = instance + '/' + encodeURIComponent(username) + '/';
            if (afterCursor) {
                url += '?after=' + encodeURIComponent(afterCursor);
            }
            log('fetchFromKittygram: trying ' + url);
            var resp = http.GET(url, kgHeaders, false);
            if (resp && resp.isOk && resp.body) {
                log('fetchFromKittygram: ' + instance + ' got ' + resp.body.length + ' bytes');
                var parsed = parseKittygramHtmlWithPagination(resp.body, username);
                if (parsed.items && parsed.items.length > 0) {
                    log('fetchFromKittygram: found ' + parsed.items.length + ' items from ' + instance + ', hasMore=' + parsed.hasMore);
                    result = parsed;
                    return true;
                }
            } else if (resp) {
                log('fetchFromKittygram: ' + instance + ' code=' + resp.code);
                failedInstance = instance;
                showToast('Request failed, switching instance');
            }
        } catch (e) {
            log('fetchFromKittygram: ' + instance + ' error: ' + e);
            failedInstance = instance;
            showToast('Request failed, switching instance');
        }
        return false;
    });

    if (result) return result;
    log('fetchFromKittygram: all instances failed');
    return null;
}

/**
 * Decodes a Kittygram /mediaproxy?url=<encoded> src attribute into a real CDN URL.
 * Kittygram percent-encodes the CDN URL and uses lowercase hex, so we need decodeURIComponent.
 * @param {string} proxySrc - e.g. "/mediaproxy?url=https%3a%2f%2fscontent..."
 * @returns {string|null} The decoded CDN URL, or null
 */
function decodeKittygramProxy(proxySrc) {
    if (!proxySrc) return null;
    try {
        var m = proxySrc.match(/\/mediaproxy\?url=(.+)/);
        if (m) return decodeURIComponent(m[1]);
    } catch {}
    return null;
}

/**
 * Parses a Kittygram profile/timeline HTML page using regex only (no DOM).
 * Returns { items, profile } where each item has:
 *   code, videoUrl, thumbnail, caption, taken_at (unix seconds), isVideo
 * and profile has: name, thumbnail, followers, bio
 */
function parseKittygramHtml(html, username) {
    var items = [];
    var seen = {};
    var profile = null;

    // ── Profile info: use domParser ───────────────────────────────────────
    try {
        var profDoc = domParser.parseFromString(html, 'text/html');
        
        // Profile picture: first <img> inside class="profile-picture"
        var profPicDiv = profDoc.querySelector('.profile-picture');
        var profThumb = null;
        if (profPicDiv) {
            var imgEl = profPicDiv.querySelector('img');
            if (imgEl) {
                var srcAttr = imgEl.getAttribute('src');
                if (srcAttr) profThumb = decodeKittygramProxy(srcAttr);
            }
        }

        // Display name: text inside <h3> inside class="usernames"
        var nameDiv = profDoc.querySelector('.usernames');
        var profName = null;
        if (nameDiv) {
            var h3El = nameDiv.querySelector('h3');
            if (h3El) profName = h3El.textContent.trim();
        }

        // Bio: text inside class="user-bio-text"
        var bioDiv = profDoc.querySelector('.user-bio-text');
        var profBio = null;
        if (bioDiv) {
            profBio = bioDiv.textContent.replace(/<[^>]+>/g, '').trim();
        }

        // Followers: first <b class="stat-number"> content
        var profFollowers = null;
        var statNumbers = profDoc.querySelectorAll('.stat-number');
        if (statNumbers.length > 0) {
            var follText = statNumbers[0].textContent;
            var fNum = parseInt(follText.replace(/,/g, ''), 10);
            if (!isNaN(fNum)) profFollowers = fNum;
        }

        if (profName || profThumb) {
            profile = { name: profName, thumbnail: profThumb, bio: profBio, followers: profFollowers };
            log('parseKittygramHtml: profile name=' + profName + ' followers=' + profFollowers);
        }
    } catch (e) {
        log('parseKittygramHtml: profile parse error: ' + e);
    }

    // ── Posts: split by <div class="item-card post"> ─────────────────────
    // Split on card boundaries so we can associate data within each card
    var cardSplitRegex = /<div class="item-card post">/g;
    var cardStarts = [];
    var m;
    while ((m = cardSplitRegex.exec(html)) !== null) cardStarts.push(m.index);

    for (var ci = 0; ci < cardStarts.length; ci++) {
        var cardStart = cardStarts[ci];
        var cardEnd = ci + 1 < cardStarts.length ? cardStarts[ci + 1] : html.length;
        var card = html.substring(cardStart, cardEnd);

        try {
            // Shortcode: <a href="/p/CODE"> (comments link at bottom of card)
            var scMatch = card.match(/href="\/p\/([A-Za-z0-9_-]{5,})"/);
            if (!scMatch) continue;
            var shortcode = scMatch[1];
            if (seen[shortcode]) continue;
            seen[shortcode] = true;

            // Video source URL: <source src="/mediaproxy?url=...">
            var videoUrl = null;
            var thumbnail = null;
            var isVideo = false;
            var duration = null;
            var sourceMatch = card.match(/<source\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
            if (sourceMatch) {
                isVideo = true;
                var decodedUrl = decodeKittygramProxy(sourceMatch[1]);
                videoUrl = decodedUrl;
                var durationMatch = decodedUrl.match(/"duration_s"\s*:\s*(\d+)/);
                if (!durationMatch) {
                    var efgMatch = decodedUrl.match(/efg=([^&]+)/);
                    if (efgMatch) {
                        try {
                            var efgUrlDecoded = decodeURIComponent(efgMatch[1]);
                            var efgJsonMatch = efgUrlDecoded.match(/"duration_s"\s*:\s*(\d+)/);
                            if (!efgJsonMatch) {
                                try {
                                    var efgBase64 = efgUrlDecoded.replace(/-/g, '+').replace(/_/g, '/');
                                    while (efgBase64.length % 4) efgBase64 += '=';
                                    var efgBinary = atob(efgBase64);
                                    var efgJsonMatch2 = efgBinary.match(/"duration_s"\s*:\s*(\d+)/);
                                    if (efgJsonMatch2) efgJsonMatch = efgJsonMatch2;
                                } catch {}
                            }
                            if (efgJsonMatch) durationMatch = efgJsonMatch;
                        } catch {}
                    }
                }
                if (durationMatch) {
                    duration = parseInt(durationMatch[1], 10);
                    log('parseKittygramHtml: extracted duration=' + duration + ' for ' + shortcode);
                }
            }

            // Thumbnail: only look inside .post-image to avoid picking up profile pics
            var cardDoc = domParser.parseFromString(card, 'text/html');
            var postImageDiv = cardDoc.querySelector('.post-image');
            if (postImageDiv) {
                var videoEl = postImageDiv.querySelector('video');
                if (videoEl) {
                    var posterAttr = videoEl.getAttribute('poster');
                    if (posterAttr && posterAttr !== 'nil') thumbnail = decodeKittygramProxy(posterAttr);
                }
                if (!thumbnail) {
                    var imgEl = postImageDiv.querySelector('img');
                    if (imgEl) {
                        var srcAttr = imgEl.getAttribute('src');
                        if (srcAttr && srcAttr !== 'nil') thumbnail = decodeKittygramProxy(srcAttr);
                    }
                }
            }

            // Caption: text inside class="post-caption-text"
            var captionMatch = card.match(/class="post-caption-text"[^>]*>([\s\S]*?)<\/p>/);
            var caption = captionMatch ? captionMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim() : null;

            // Timestamp: use "Posted at:" text (more reliable than <time> element)
            var taken_at = null;
            var timeMatch = card.match(/Posted at:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
            if (timeMatch) {
                taken_at = parseDatetimeToUnix(timeMatch[1]);
                log('parseKittygramHtml: taken_at from Posted at text=' + taken_at + ' for ' + shortcode);
            }
            if (!taken_at) {
                var timeEl = cardDoc.querySelector('time');
                if (timeEl) {
                    var dtAttr = timeEl.getAttribute('datetime');
                    if (dtAttr) taken_at = parseDatetimeToUnix(dtAttr);
                }
            }

            // Likes: use domParser on .post-likes, handle "nil likes"
            var likes = null;
            try {
                var likesEl = cardDoc.querySelector('.post-likes');
                if (likesEl) {
                    var likesText = likesEl.textContent || '';
                    if (likesText.toLowerCase().indexOf('nil') === -1) {
                        var likesMatch = likesText.match(/([\d,]+)/);
                        if (likesMatch) {
                            var likesNum = parseInt(likesMatch[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum)) likes = likesNum;
                        }
                    }
                }
            } catch (e) {
                log('parseKittygramHtml: likes parse error: ' + e);
            }

            // Comments: <a href="/p/CODE"> 257 Comments</a>
            var commentsMatch = card.match(/href="\/p\/' + shortcode + '"[^>]*>(\d+)\s+Comments<\/a>/);
            var commentsMatchAlt = card.match(/href="\/p\/' + shortcode + '">\s*(\d+)\s+Comments/);
            var comments = null;
            if (commentsMatch || commentsMatchAlt) {
                var cm = commentsMatch || commentsMatchAlt;
                var commentsNum = parseInt(cm[1], 10);
                if (!isNaN(commentsNum)) comments = commentsNum;
            }

            items.push({
                code: shortcode,
                videoUrl: videoUrl,
                thumbnail: thumbnail,
                caption: caption ? { text: caption } : null,
                taken_at: taken_at,
                isVideo: isVideo,
                likes: likes,
                comments: comments,
                duration: duration
            });
        } catch (e) {
            log('parseKittygramHtml: card parse error: ' + e);
        }
    }

    return { items: items, profile: profile };
}

/**
 * Parses a Kittygram profile/timeline HTML page and extracts pagination info.
 * Returns { items, profile, nextCursor, hasMore }.
 */
function parseKittygramHtmlWithPagination(html, username) {
    var result = parseKittygramHtml(html, username);
    var nextCursor = null;
    var hasMore = false;

    try {
        var nextPageMatch = html.match(/href="(\?after=[^"]+)"\s+class="next-button"/);
        if (nextPageMatch && nextPageMatch[1]) {
            var afterParam = nextPageMatch[1].replace('?after=', '');
            nextCursor = afterParam;
            hasMore = nextCursor && nextCursor.length > 0;
            log('parseKittygramHtmlWithPagination: found nextCursor=' + nextCursor.substring(0, 30) + '...');
        }
    } catch (e) {
        log('parseKittygramHtmlWithPagination: error extracting pagination: ' + e);
    }

    return {
        items: result.items,
        profile: result.profile,
        nextCursor: nextCursor,
        hasMore: hasMore
    };
}

/**
 * Fetches a single post page from a Kittygram instance and returns the video URL and thumbnail.
 * Used as a fallback in fetchVideoUrl when Instagram's own API fails.
 * @param {string} shortcode
 * @returns {{ videoUrl: string|null, thumbnail: string|null }}
 */
/**
 * Fetches a post page from Kittygram and returns video URL, thumbnail, and metadata.
 * @param {string} shortcode - Post shortcode
 * @returns {{ videoUrl: string|null, thumbnail: string|null, caption: string|null, author: string|null, datetime: number|null }}
 */
function fetchKittygramPostData(shortcode) {
    var kgHeaders = {
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'navigate'
    };
    var instances = getKittygramInstances();
    var result = null;
    instances.some(function(instance) {
        try {
            var url = instance + '/p/' + shortcode;
            log('fetchKittygramPostData: trying ' + url);
            var resp = http.GET(url, kgHeaders, false);
            if (resp && resp.isOk && resp.body) {
                var body = resp.body;
                var videoUrl = null;
                var thumbnail = null;
                var caption = null;
                var author = null;
                var datetime = null;
                var duration = null;

                // Video source: <source src="/mediaproxy?url=...">
                var sourceMatch = body.match(/<source\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
                if (sourceMatch) {
                    var decodedUrl = decodeKittygramProxy(sourceMatch[1]);
                    videoUrl = decodedUrl;
                    log('fetchKittygramPostData: decodedUrl=' + decodedUrl.substring(0, 100) + '...');
                    // Try direct duration_s match first
                    var durationMatch = decodedUrl.match(/"duration_s"\s*:\s*(\d+)/);
                    if (!durationMatch) {
                        // Try to extract from efg param which is base64 encoded JSON
                        var efgMatch = decodedUrl.match(/efg=([^&]+)/);
                        log('fetchKittygramPostData: efgMatch=' + (efgMatch ? 'found' : 'null'));
                        if (efgMatch) {
                            try {
                                // efg is URL-encoded base64, need to URL decode then base64 decode
                                var efgUrlDecoded = decodeURIComponent(efgMatch[1]);
                                log('fetchKittygramPostData: efgUrlDecoded length=' + efgUrlDecoded.length);
                                // Try to parse as JSON directly (it's base64 encoded but might be URL-safe)
                                var efgJsonMatch = efgUrlDecoded.match(/"duration_s"\s*:\s*(\d+)/);
                                if (!efgJsonMatch) {
                                    // Try base64 decode
                                    try {
                                        var efgBase64 = efgUrlDecoded.replace(/-/g, '+').replace(/_/g, '/');
                                        while (efgBase64.length % 4) efgBase64 += '=';
                                        var efgBinary = atob(efgBase64);
                                        var efgJsonMatch2 = efgBinary.match(/"duration_s"\s*:\s*(\d+)/);
                                        if (efgJsonMatch2) efgJsonMatch = efgJsonMatch2;
                                    } catch {}
                                }
                                if (efgJsonMatch) durationMatch = efgJsonMatch;
                            } catch (e) {
                                log('fetchKittygramPostData: efg parse error: ' + e);
                            }
                        }
                    }
                    log('fetchKittygramPostData: durationMatch=' + (durationMatch ? durationMatch[1] : 'null'));
                    if (durationMatch) {
                        duration = parseInt(durationMatch[1], 10);
                    }
                }

                // Thumbnail - only look inside .post-image to avoid picking up the user's profile pic
                var bodyDoc = domParser.parseFromString(body, 'text/html');
                var postImageDiv = bodyDoc.querySelector('.post-image');
                if (postImageDiv) {
                    // video poster (skip "nil" literal Kittygram uses when there is none)
                    var videoEl = postImageDiv.querySelector('video');
                    if (videoEl) {
                        var posterAttr = videoEl.getAttribute('poster');
                        if (posterAttr && posterAttr !== 'nil') thumbnail = decodeKittygramProxy(posterAttr);
                    }
                    // photo post: <img> directly inside .post-image
                    if (!thumbnail) {
                        var imgEl = postImageDiv.querySelector('img');
                        if (imgEl) {
                            var srcAttr = imgEl.getAttribute('src');
                            if (srcAttr && srcAttr !== 'nil') thumbnail = decodeKittygramProxy(srcAttr);
                        }
                    }
                }
                log('fetchKittygramPostData: thumbnail=' + (thumbnail ? thumbnail.substring(0, 60) + '...' : 'none'));

                // Caption: class="post-caption-text"
                var captionMatch = body.match(/class="post-caption-text"[^>]*>([\s\S]*?)<\/p>/);
                if (captionMatch) {
                    caption = captionMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim();
                }

                // Author: class="username" inside .user-info
                var authorMatch = body.match(/class="user-info"[\s\S]*?class="username"[^>]*>([^<]+)/);
                if (authorMatch) author = authorMatch[1].trim();

                // Author thumbnail: <header class="user-info"><img src="...">
                var authorThumbMatch = body.match(/class="user-info"[\s\S]*?<img\s[^>]*src="(\/mediaproxy\?url=[^"]+)"/);
                var authorThumb = '';
                if (authorThumbMatch) {
                    authorThumb = decodeKittygramProxy(authorThumbMatch[1]);
                }

                // Datetime: read from <time class="post-time" datetime="YYYY-MM-DDTHH:MM:SS">
                var timeEl = bodyDoc.querySelector('time.post-time');
                if (timeEl) {
                    var dtAttr = timeEl.getAttribute('datetime');
                    if (dtAttr) {
                        datetime = parseDatetimeToUnix(dtAttr);
                        log('fetchKittygramPostData: parsed datetime=' + datetime + ' from datetime attr "' + dtAttr + '"');
                    }
                }
                if (!datetime) {
                    // Fallback: scrape "Posted at: YYYY-MM-DD HH:MM:SS" from text
                    var timeMatch = body.match(/Posted at:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                    if (timeMatch) {
                        datetime = parseDatetimeToUnix(timeMatch[1]);
                        log('fetchKittygramPostData: parsed datetime=' + datetime + ' from text fallback "' + timeMatch[1] + '"');
                    }
                }

                // Likes: use domParser to extract like count - handle "nil likes" (hidden count)
                var likes = null;
                var postDoc = domParser.parseFromString(body, 'text/html');
                var likesEl = postDoc.querySelector('.post-likes');
                if (likesEl) {
                    var likesText = likesEl.textContent || '';
                    log('fetchKittygramPostData: .post-likes text="' + likesText.trim() + '"');
                    if (likesText.toLowerCase().indexOf('nil') === -1) {
                        var likesMatch = likesText.match(/([\d,]+)/);
                        if (likesMatch) {
                            var likesNum = parseInt(likesMatch[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum)) likes = likesNum;
                        }
                    }
                } else {
                    // Fallback: scan full body text
                    var bodyText = postDoc.body ? postDoc.body.textContent : '';
                    if (bodyText.toLowerCase().indexOf('nil likes') === -1) {
                        var likesMatch2 = bodyText.match(/([\d,]+)\s*likes?/i);
                        if (likesMatch2) {
                            var likesNum2 = parseInt(likesMatch2[1].replace(/,/g, ''), 10);
                            if (!isNaN(likesNum2)) likes = likesNum2;
                        }
                    }
                }
                log('fetchKittygramPostData: extracted likes=' + (likes !== null ? likes : 'nil/null'));

                if (videoUrl || thumbnail) {
                    log('fetchKittygramPostData: found videoUrl=' + (videoUrl ? 'yes' : 'no') + ' thumb=' + (thumbnail ? 'yes' : 'no') + ' likes=' + (likes ? likes : 'none') + ' duration=' + (duration ? duration : 'none') + ' from ' + instance);
                    result = { videoUrl: videoUrl, thumbnail: thumbnail, caption: caption, author: author, authorThumb: authorThumb, datetime: datetime, likes: likes, duration: duration };
                    return true;
                }
            } else if (resp) {
                log('fetchKittygramPostData: ' + instance + ' code=' + resp.code);
            }
        } catch (e) {
            log('fetchKittygramPostData: ' + instance + ' error: ' + e);
        }
        return false;
    });

    if (result) return result;
    return { videoUrl: null, thumbnail: null, caption: null, author: null, authorThumb: '', datetime: null, likes: null, duration: null };
}

/**
 * Fetches a user's media feed via Instagram's web API.
 * Tries multiple endpoints to handle rate limiting.
 * Returns a list of items with shortcodes, caption, thumbnail URLs, etc.
 * @param {string} userId - Numeric Instagram user ID
 * @param {Object} session - Session object with lsd and mid
 * @returns {Object|null} Parsed JSON response, or null
 */
function fetchUserFeed(userId, session, cursor) {
    // Primary endpoint: feed/user
    var endpoints = [];
    // Use fewer items per page to reduce rate limiting
    var baseUrl = '/api/v1/feed/user/' + userId + '/?count=12';
    if (cursor) baseUrl += '&max_id=' + encodeURIComponent(cursor);
    endpoints.push(baseUrl);
    // Alternative: reel media tray (may return different rate limit bucket)
    endpoints.push('/api/v1/feed/user/' + userId + '/reel_media/');
    // Try with media info endpoint for just the user's media count
    endpoints.push('/api/v1/users/' + userId + '/full_detail_info/');

    for (var e = 0; e < endpoints.length; e++) {
        var url = API_URLS.base + endpoints[e];
        log('fetchUserFeed: trying ' + endpoints[e]);

        try {
            var headers = apiHeaders(session.lsd, session.mid);
            var resp = http.GET(url, headers, false);
            if (resp && resp.body) {
                log('fetchUserFeed: code=' + resp.code + ' length=' + resp.body.length);
                if (resp.isOk) {
                    var parsed = tryParse(resp.body);
                    if (parsed) {
                        log('fetchUserFeed: parsed keys=' + Object.keys(parsed).join(', '));
                        if (parsed.items) log('fetchUserFeed: found ' + parsed.items.length + ' items');
                        // Return response with pagination metadata
                        return {
                            items: parsed.items || [],
                            hasMore: parsed.more_available === true,
                            nextCursor: parsed.next_max_id || null,
                            raw: parsed
                        };
                    }
                } else if (resp.code === 401) {
                    log('fetchUserFeed: 401 (needs login sessionid cookie)');
                } else {
                    log('fetchUserFeed: first 300=' + resp.body.substring(0, 300));
                }
            }
        } catch (e) {
            log('fetchUserFeed: error: ' + e);
        }
    }

    log('fetchUserFeed: all endpoints failed');
    return { items: [], hasMore: false, nextCursor: null };
}

/**
 * Makes a GraphQL POST query to Instagram's API.
 * Tries http.POST first, then http.requestWithBody fallback.
 * @param {string} queryHash - The query hash for the desired operation
 * @param {Object} variables - Variables to pass to the query
 * @param {string} lsd - LSD token
 * @param {string} mid - Mid cookie value
 * @returns {Object|null} Parsed JSON response, or null
 */
function graphqlQuery(queryHash, variables, lsd, mid) {
    var url = API_URLS.base + API_URLS.graphql;
    var body = 'query_hash=' + queryHash + '&variables=' + encodeURIComponent(JSON.stringify(variables));
    var headers = apiHeaders(lsd, mid);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    log('graphqlQuery: hash=' + queryHash.substring(0, 8) + '... url=' + url);

    // Try POST with correct signature: http.POST(url, body, headers, useAuthClient)
    try {
        log('graphqlQuery: trying POST');
        var resp = http.POST(url, body, headers, false);
        if (resp && resp.body) {
            log('graphqlQuery: POST code=' + resp.code + ' length=' + resp.body.length);
            if (resp.body) log('graphqlQuery: POST first 200=' + resp.body.substring(0, 200));
            if (resp.isOk) {
                var parsed = tryParse(resp.body);
                if (parsed) return parsed;
            }
        }
    } catch (e) {
        log('graphqlQuery: POST error: ' + e);
    }

    // Fallback: http.requestWithBody(method, url, body, headers, useAuthClient)
    try {
        log('graphqlQuery: trying requestWithBody');
        var resp = http.requestWithBody("POST", url, body, headers, false);
        if (resp && resp.body) {
            log('graphqlQuery: requestWithBody code=' + resp.code + ' length=' + resp.body.length);
            if (resp.isOk) {
                var parsed = tryParse(resp.body);
                if (parsed) return parsed;
            }
        }
    } catch (e) {
        log('graphqlQuery: requestWithBody error: ' + e);
    }

    log('graphqlQuery: all strategies failed');
    return null;
}

/**
 * Fetches feed items for a user, trying multiple strategies in order:
 * 1. __a=1&__d=dis (HTTP 201 HTML with embedded JSON)
 * 2. web_profile_info GET/POST
 * 3. Mobile API (i.instagram.com)
 * 4. fetchUserFeed (rate-limited fallback)
 * Returns items with shortcodes, captions, thumbnails, and video URL caches.
 * @param {string} username - Instagram username
 * @param {string|null} cursor - Pagination cursor
 * @returns {{items: Array, hasMore: boolean, nextCursor: string|null}}
 */
function fetchFeedItems(username, cursor) {
    log('fetchFeedItems: username=' + username + ' cursor=' + (cursor || 'null'));
    var session = getSession();
    if (!session.lsd) {
        log('fetchFeedItems: no lsd token, continuing with cookie-only fallbacks');
        session.lsd = session.lsd || '';
        session.mid = session.mid || '';
    }

    // Try __a=1&__d=dis with browser-like headers first (not rate-limited like web_profile_info)
    if (!cursor) {
        // Try __a=1&__d=dis with browser-like headers
        var disVariants = [
            { label: 'browser-headers', headers: (function() { var h = defaultHeaders(); h['Accept'] = 'application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'; return h; })() },
            { label: 'browser+lsd', headers: (function() { var h = defaultHeaders(); h['Accept'] = 'application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'; if (session.lsd) h['x-fb-lsd'] = session.lsd; return h; })() },
            { label: 'api-headers', headers: (function() { var h = apiHeaders(session.lsd || '', session.mid || ''); h['Accept'] = 'application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'; return h; })() }
        ];
        for (var dv = 0; dv < disVariants.length; dv++) {
            try {
                var disUrl = API_URLS.base + '/' + encodeURIComponent(username) + '/?__a=1&__d=dis';
                log('fetchFeedItems: trying __a=1&__d=dis with ' + disVariants[dv].label);
                var disResp = http.GET(disUrl, disVariants[dv].headers, false);
                if (disResp) {
                    log('fetchFeedItems: __a=1&__d=dis ' + disVariants[dv].label + ' code=' + disResp.code + ' len=' + (disResp.body ? disResp.body.length : 0));
                    if (disResp.isOk && disResp.body) {
                        var disData = tryParse(disResp.body);
                        if (disData) {
                            log('fetchFeedItems: __a=1&__d=dis parsed keys=' + Object.keys(disData).join(','));
                            var graphUser = null;
                            try { graphUser = disData.graphql && disData.graphql.user; } catch {}
                            try { if (!graphUser) graphUser = disData.data && disData.data.user; } catch {}
                            if (graphUser) {
                                var sources = [
                                    { name: 'timeline', data: graphUser.edge_owner_to_timeline_media },
                                    { name: 'reels', data: graphUser.edge_felix_video_timeline }
                                ];
                                for (var si = 0; si < sources.length; si++) {
                                    var conn = sources[si].data;
                                    if (conn && conn.edges && conn.edges.length > 0) {
                                        log('fetchFeedItems: __a=1&__d=dis found ' + conn.edges.length + ' ' + sources[si].name + ' edges');
                                        var items = [];
                                        for (var ei = 0; ei < conn.edges.length; ei++) {
                                            var node = conn.edges[ei].node;
                                            if (!node || !node.shortcode) continue;
                                            var isReel = node.media_type === 2 || node.product_type === 'clips' || node.__typename === 'XDTGraphVideo';
                                            var isVideo = node.is_video || (node.video_versions && node.video_versions.length > 0) || node.video_duration;
                                            items.push({
                                                code: node.shortcode,
                                                id: node.id,
                                                taken_at: node.taken_at_timestamp,
                                                video_versions: node.video_versions || null,
                                                image_versions2: node.thumbnail_resources ? { candidates: node.thumbnail_resources } : null,
                                                caption: node.edge_media_to_caption && node.edge_media_to_caption.edges && node.edge_media_to_caption.edges[0] ? { text: node.edge_media_to_caption.edges[0].node.text } : null,
                                                product_type: isReel ? 'clips' : (isVideo ? 'feed' : null),
                                                video_duration: node.video_duration || null
                                            });
                                        }
                                        var hasMore = conn.page_info ? conn.page_info.has_next_page : false;
                                        var nextCursor = conn.page_info ? conn.page_info.end_cursor : null;
                                        return { items: items, hasMore: hasMore, nextCursor: nextCursor };
                                    }
                                }
                            }
                        } else if (disResp.body) {
                            log('fetchFeedItems: __a=1&__d=dis body preview=' + disResp.body.substring(0, 300));
                        }
                    }
                }
            } catch (e) {
                log('fetchFeedItems: __a=1&__d=dis ' + disVariants[dv].label + ' error: ' + e);
            }
        }
    }

    // Get user profile data (includes edge_owner_to_timeline_media with recent posts)
    // Note: web_profile_info often returns 401 in 2024+ (requires sessionid cookie).
    // This is NOT a session issue — don't clear the session and retry, as it will
    // still return 401. Just try once more with whatever session we have.
    var userData = fetchWebProfile(username, session);
    if (!userData) {
        log('fetchFeedItems: web_profile_info failed, continuing with fallbacks');
    }
    // Refresh session (set midCookie from cookieStore) but don't clear anything
    if (!userData && (!lsdToken || !midCookie)) {
        session = getSession();
    }

    var userObj = null;
    if (userData) {
        try { userObj = userData.data.user; } catch {}
    }
    if (!userObj) {
        log('fetchFeedItems: no user object, will try mobile API fallback');
    }

    var userId = userObj ? userObj.id : null;

    // Try to extract items from web_profile_info's edge_owner_to_timeline_media
    // This bypasses the rate-limited feed API because web_profile_info has a different rate limit
    if (userObj && !cursor && userObj.edge_owner_to_timeline_media && userObj.edge_owner_to_timeline_media.edges) {
        var graphEdges = userObj.edge_owner_to_timeline_media.edges;
        log('fetchFeedItems: web_profile_info has ' + graphEdges.length + ' timeline edges');
        var items = [];
        graphEdges.forEach(function(edge) {
            var node = edge.node;
            if (!node || !node.shortcode) return;
            var isReel = node.media_type === 2 || node.product_type === 'clips' || node.__typename === 'XDTGraphVideo';
            var isVideo = node.is_video || (node.video_versions && node.video_versions.length > 0) || node.video_duration;
            items.push({
                code: node.shortcode,
                id: node.id,
                taken_at: node.taken_at_timestamp,
                video_versions: node.video_versions || null,
                image_versions2: node.thumbnail_resources ? { candidates: node.thumbnail_resources } : null,
                display_url: node.display_url || null,
                thumbnail_src: node.thumbnail_src || null,
                thumbnail_resources: node.thumbnail_resources || null,
                caption: node.edge_media_to_caption && node.edge_media_to_caption.edges && node.edge_media_to_caption.edges[0] ? { text: node.edge_media_to_caption.edges[0].node.text } : null,
                product_type: isReel ? 'clips' : (isVideo ? 'feed' : null),
                video_duration: node.video_duration || null
            });
        });
        var hasMore = userObj.edge_owner_to_timeline_media.page_info && userObj.edge_owner_to_timeline_media.page_info.has_next_page;
        var nextCursor = userObj.edge_owner_to_timeline_media.page_info ? userObj.edge_owner_to_timeline_media.page_info.end_cursor : null;
        log('fetchFeedItems: from timeline: ' + items.length + ' items, hasMore=' + hasMore);
        return { items: items, hasMore: hasMore, nextCursor: nextCursor };
    }

    // Fallback: try reel media (clips/reels)
    if (userObj && !cursor && userObj.edge_felix_video_timeline && userObj.edge_felix_video_timeline.edges) {
        var reelEdges = userObj.edge_felix_video_timeline.edges;
        log('fetchFeedItems: web_profile_info has ' + reelEdges.length + ' reel edges');
        var items = [];
        reelEdges.forEach(function(edge) {
            var node = edge.node;
            if (!node || !node.shortcode) return;
            items.push({
                code: node.shortcode,
                id: node.id,
                taken_at: node.taken_at_timestamp,
                video_versions: node.video_versions || null,
                image_versions2: node.thumbnail_resources ? { candidates: node.thumbnail_resources } : null,
                caption: node.edge_media_to_caption && node.edge_media_to_caption.edges && node.edge_media_to_caption.edges[0] ? { text: node.edge_media_to_caption.edges[0].node.text } : null,
                product_type: 'clips',
                video_duration: node.video_duration || null
            });
        });
        var hasMore = userObj.edge_felix_video_timeline.page_info && userObj.edge_felix_video_timeline.page_info.has_next_page;
        var nextCursor = userObj.edge_felix_video_timeline.page_info ? userObj.edge_felix_video_timeline.page_info.end_cursor : null;
        log('fetchFeedItems: from reels: ' + items.length + ' items, hasMore=' + hasMore);
        return { items: items, hasMore: hasMore, nextCursor: nextCursor };
    }

    // Mobile API fallback: try i.instagram.com with mobile headers (different rate limit bucket)
    // Try even when cursor is present for pagination - mobile API uses max_id instead of end_cursor
    if (!userId || cursor) {
        try {
            var mobileUA = 'Instagram 100.0.0.0.100 Android (28/9; 420dpi; 1080x1920; samsung; SM-G975F; beyond2; exynos9820; en_US)';
            var mobileHeaders = {
                'User-Agent': mobileUA,
                'Accept': '*/*',
                'X-IG-App-ID': IG_APP_ID_ALT,
                'X-CSRFToken': 'missing',
            };
            if (cookieStore) mobileHeaders['Cookie'] = cookieStore;
            // Try username info endpoint to get user ID if we don't have it yet
            if (!userId) {
                var infoUrl = 'https://i.instagram.com/api/v1/users/' + encodeURIComponent(username) + '/usernameinfo/';
                log('fetchFeedItems: trying mobile API username info');
                var infoResp = http.GET(infoUrl, mobileHeaders, false);
                if (infoResp && infoResp.isOk && infoResp.body) {
                    log('fetchFeedItems: mobile API username info code=' + infoResp.code + ' len=' + infoResp.body.length);
                    var infoData = tryParse(infoResp.body);
                    if (infoData && infoData.user && infoData.user.pk) {
                        userId = infoData.user.pk;
                        log('fetchFeedItems: mobile API got userId=' + userId);
                    }
                } else if (infoResp) {
                    log('fetchFeedItems: mobile API username info code=' + infoResp.code + ' len=' + (infoResp.body ? infoResp.body.length : 0));
                }
            }
        } catch (e) {
            log('fetchFeedItems: mobile API info error: ' + e);
        }
    }

    // Mobile API feed fallback: try i.instagram.com feed endpoint
    if (userId && !cursor) {
        try {
            var mobileUA = 'Instagram 100.0.0.0.100 Android (28/9; 420dpi; 1080x1920; samsung; SM-G975F; beyond2; exynos9820; en_US)';
            var feedHeaders = {
                'User-Agent': mobileUA,
                'Accept': '*/*',
                'X-IG-App-ID': IG_APP_ID_ALT,
                'X-CSRFToken': 'missing',
            };
            if (cookieStore) feedHeaders['Cookie'] = cookieStore;
            var feedUrl = 'https://i.instagram.com/api/v1/feed/user/' + userId + '/?count=12';
            if (cursor) feedUrl += '&max_id=' + encodeURIComponent(cursor);
            log('fetchFeedItems: trying mobile API feed' + (cursor ? ' with cursor' : ''));
            var feedResp = http.GET(feedUrl, feedHeaders, false);
            if (feedResp && feedResp.isOk && feedResp.body) {
                var feedData = tryParse(feedResp.body);
                if (feedData && feedData.items) {
                    log('fetchFeedItems: mobile API feed got ' + feedData.items.length + ' items');
                    var items = [];
                    for (var mi = 0; mi < feedData.items.length; mi++) {
                        var mitem = feedData.items[mi];
                        if (!mitem || !mitem.code) continue;
                        var isReel = mitem.media_type === 2 || mitem.product_type === 'clips';
                        var isVideo = mitem.is_video || (mitem.video_versions && mitem.video_versions.length > 0) || mitem.video_duration;
                        items.push({
                            code: mitem.code,
                            id: mitem.id || mitem.pk,
                            taken_at: mitem.taken_at,
                            video_versions: mitem.video_versions || null,
                            image_versions2: mitem.image_versions2 || null,
                            caption: mitem.caption ? { text: mitem.caption.text || '' } : null,
                            product_type: isReel ? 'clips' : (isVideo ? 'feed' : null),
                            video_duration: mitem.video_duration || null
                        });
                    }
                    if (items.length > 0) {
                        return { items: items, hasMore: !!feedData.more_available, nextCursor: feedData.next_max_id || null };
                    }
                }
            } else if (feedResp) {
                log('fetchFeedItems: mobile API feed code=' + feedResp.code + ' len=' + (feedResp.body ? feedResp.body.length : 0));
            }
        } catch (e) {
            log('fetchFeedItems: mobile API feed error: ' + e);
        }
    }

    // Last resort: try the rate-limited feed API
    if (userId) {
        var feedResult = fetchUserFeed(userId, session, cursor);
        if ((!feedResult || !feedResult.items || feedResult.items.length === 0) && (!lsdToken || !midCookie)) {
            log('fetchFeedItems: session was stale, retrying with fresh session');
            session = getSession();
            if (session.lsd && session.mid) {
                feedResult = fetchUserFeed(userId, session, cursor);
            }
        }
        if (feedResult && feedResult.items) {
            log('fetchFeedItems: returning ' + feedResult.items.length + ' items, hasMore=' + feedResult.hasMore);
            return feedResult;
        }
    }

    log('fetchFeedItems: no feed source available');
    return { items: [], hasMore: false, nextCursor: null };
}

/**
 * Attempts to fetch the direct video URL for a given Instagram shortcode.
 * Tries multiple strategies in order of reliability.
 * @param {string} shortcode - Instagram media shortcode
 * @returns {string|null} Video URL, or null
 */
function fetchVideoUrl(shortcode) {
    log('fetchVideoUrl: shortcode=' + shortcode);
    var session = getSession();

    // Strategy 1: Try the web API media info endpoint for video_versions
    log('fetchVideoUrl: trying web API media info');
    if (session.lsd && session.mid) {
        var mediaUrl = API_URLS.base + '/api/v1/media/' + shortcode + '/info/';
        var appIdsToTry = [IG_APP_ID, IG_APP_ID_ALT];
        for (var ai = 0; ai < appIdsToTry.length; ai++) {
            try {
                var headers = (appIdsToTry[ai] === IG_APP_ID)
                    ? apiHeaders(session.lsd, session.mid)
                    : apiHeadersAlt(session.lsd, session.mid);
                headers['Referer'] = API_URLS.base + '/p/' + shortcode + '/';
                log('fetchVideoUrl: media info with appId=' + appIdsToTry[ai].substring(0, 6) + '...');
                var resp = http.GET(mediaUrl, headers, false);
                if (resp && resp.isOk && resp.body) {
                    var parsed = tryParse(resp.body);
                    if (parsed && parsed.items && parsed.items[0]) {
                        var item = parsed.items[0];
                        // Try video_versions array
                        if (item.video_versions && item.video_versions.length > 0) {
                            var best = item.video_versions[0];
                            log('fetchVideoUrl: found via web API video_versions: ' + (best.url || '').substring(0, 60));
                            return best.url;
                        }
                        // Try direct video_url
                        if (item.video_url) {
                            log('fetchVideoUrl: found via web API video_url');
                            return item.video_url;
                        }
                    } else {
                        log('fetchVideoUrl: web API media info - no items in response');
                    }
                } else {
                    log('fetchVideoUrl: web API media info - resp=' + (resp ? resp.code + ' ok=' + resp.isOk + ' bodyLen=' + resp.body.length : 'null'));
                }
            } catch (e) {
                log('fetchVideoUrl: web API media info error with appId=' + appIdsToTry[ai].substring(0, 6) + '...: ' + e);
            }
        }

        // Strategy 2: Try the GraphQL API
        try {
            log('fetchVideoUrl: trying GraphQL');
            var mediaData = graphqlQuery(QUERY_HASHES.mediaInfo, { shortcode: shortcode }, session.lsd, session.mid);
            if (mediaData) {
                var videoUrl = null;
                try {
                    videoUrl = mediaData.data.shortcode_media.video_url;
                    log('fetchVideoUrl: GraphQL returned video_url=' + (videoUrl ? videoUrl.substring(0, 60) + '...' : 'null'));
                } catch (e) {
                    log('fetchVideoUrl: could not extract video_url: ' + e);
                }
                if (videoUrl) return videoUrl;
            } else {
                log('fetchVideoUrl: GraphQL mediaData is null');
            }
        } catch (e) {
            log('fetchVideoUrl: GraphQL error: ' + e);
        }
    } else {
        log('fetchVideoUrl: no csrftoken');
    }

    // Strategy 1b: Check video URL cache
    if (videoUrlCache[shortcode]) {
        log('fetchVideoUrl: found in cache');
        return videoUrlCache[shortcode];
    }

    // Strategy 2: Fetch the post page and look for video data
    var pageUrl = API_URLS.base + '/p/' + shortcode + '/';
    var response = null;

    // Try with session headers first for richer data
    if (session.lsd || session.mid) {
        var sessionHeaders = apiHeaders(session.lsd || '', session.mid || '');
        sessionHeaders['Referer'] = pageUrl;
        response = http.GET(pageUrl, sessionHeaders, false);
    }

    if (!response || !response.isOk) {
        response = http.GET(pageUrl, defaultHeaders(), false);
    }

    // Extract LSD from the post page if we don't have it yet
    if (response && response.isOk && response.body && !lsdToken) {
        var pageLsd = extractLsdToken(response.body);
        if (pageLsd) {
            lsdToken = pageLsd;
            log('fetchVideoUrl: found LSD from post page=' + lsdToken.substring(0, 10) + '...');
            // Retry web API with the newly found LSD
            if (midCookie) {
                try {
                    var mediaUrl = API_URLS.base + '/api/v1/media/' + shortcode + '/info/';
                    var retryHeaders = apiHeaders(lsdToken, midCookie);
                    retryHeaders['Referer'] = pageUrl;
                    var retryResp = http.GET(mediaUrl, retryHeaders, false);
                    if (retryResp && retryResp.isOk && retryResp.body) {
                        var retryParsed = tryParse(retryResp.body);
                        if (retryParsed && retryParsed.items && retryParsed.items[0]) {
                            var retryItem = retryParsed.items[0];
                            if (retryItem.video_versions && retryItem.video_versions.length > 0) {
                                log('fetchVideoUrl: found video via retry with LSD');
                                return retryItem.video_versions[0].url;
                            }
                        }
                    }
                } catch (e) {
                    log('fetchVideoUrl: retry with LSD error: ' + e);
                }
            }
        }
    }

    if (response && response.isOk) {
        // Try LD+JSON structured data
        var ldVideo = extractLdVideo(response.body);
        if (ldVideo && ldVideo.contentUrl) {
            log('fetchVideoUrl: found via LD+JSON VideoObject.contentUrl');
            return ldVideo.contentUrl;
        }

        // Try extractScreenshotVideo: checks <link rel="preload" as="video"> and og:video meta
        var screenshotVid = extractScreenshotVideo(response.body);
        if (screenshotVid && screenshotVid.indexOf('.mp4') !== -1) {
            log('fetchVideoUrl: found via screenshotVideo preload');
            return screenshotVid;
        }

        // Try extracting from __NEXT_DATA__ (Next.js hydration data - used by modern Instagram)
        var nextDataMatch = response.body.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
            var nextData = tryParse(nextDataMatch[1]);
            if (nextData) {
                var vidFromNext = extractVideoUrlFromGraphql(nextData);
                if (vidFromNext) return vidFromNext;
                // Also try nested props.pageProps
                try {
                    var pageProps = nextData.props && nextData.props.pageProps;
                    if (pageProps) {
                        var vidFromProps = extractVideoUrlFromGraphql(pageProps);
                        if (vidFromProps) return vidFromProps;
                    }
                } catch {}
            }
        }

        // Try extracting from window.__INITIAL_STATE__ (legacy React app state)
        var initStateMatch = response.body.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (initStateMatch) {
            var initState = tryParse(initStateMatch[1]);
            if (initState) {
                var vidFromInit = extractVideoUrlFromGraphql(initState);
                if (vidFromInit) {
                    log('fetchVideoUrl: found via __INITIAL_STATE__');
                    return vidFromInit;
                }
            }
        }

        // Try extracting from window._sharedData (legacy Instagram data)
        var sharedDataMatch = response.body.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (sharedDataMatch) {
            var sharedData = tryParse(sharedDataMatch[1]);
            if (sharedData) {
                var vidFromShared = extractVideoUrlFromGraphql(sharedData);
                if (vidFromShared) {
                    log('fetchVideoUrl: found via _sharedData');
                    return vidFromShared;
                }
            }
        }

        // Search for CDN video URLs in the page HTML
        var cdnVideoRegex = /https?:\/\/scontent[^"'\s]*\/v\/[^"'\s]*\.mp4[^"'\s]*/g;
        var matches = response.body.match(cdnVideoRegex);
        if (matches && matches.length > 0) {
            log('fetchVideoUrl: found via CDN regex');
            return matches[0];
        }

        // Search for video URLs from a different CDN pattern
        var cdnVideoRegex2 = /https?:\/\/video[^"'\s]*\.cdninstagram\.com[^"'\s]*/g;
        var matches2 = response.body.match(cdnVideoRegex2);
        if (matches2 && matches2.length > 0) return matches2[0];

        // Search for "video_url" in embedded JSON data
        var videoUrlRegex = /"video_url"\s*:\s*"([^"]+)"/g;
        var vMatch;
        while ((vMatch = videoUrlRegex.exec(response.body)) !== null) {
            var decoded = vMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
            if (decoded.indexOf('.mp4') !== -1 || decoded.indexOf('cdninstagram') !== -1) {
                log('fetchVideoUrl: found via video_url regex');
                return decoded;
            }
        }
    }

    // Strategy 3: Try the legacy __a=1 API endpoint
    // Instagram returns HTML but the page may have video data in script tags
    try {
        var apiUrl = API_URLS.base + '/p/' + shortcode + '/?__a=1';
        log('fetchVideoUrl: trying __a=1 API: ' + apiUrl);
        var apiResponse = http.GET(apiUrl, defaultHeaders(), false);

        if (apiResponse && apiResponse.isOk && apiResponse.body) {
            log('fetchVideoUrl: __a=1 response length=' + apiResponse.body.length);
            var apiJson = tryParse(apiResponse.body);
            if (apiJson) {
                var vidUrl = extractVideoUrlFromGraphql(apiJson);
                if (vidUrl) {
                    log('fetchVideoUrl: found via __a=1 JSON');
                    return vidUrl;
                }
            }
            // Response may be HTML with embedded video data - search for patterns
            var htmlVid = extractVideoUrlFromHtml(apiResponse.body);
            if (htmlVid) {
                log('fetchVideoUrl: found via __a=1 HTML');
                return htmlVid;
            }
        }
    } catch (e) {
        log('fetchVideoUrl: __a=1 error: ' + e);
    }

    // Strategy 3b: Try __a=1&__d=dis with browser-like headers (from drawrowfly/instagram-scraper approach)
    try {
        var disUrl = API_URLS.base + '/p/' + shortcode + '/?__a=1&__d=dis';
        log('fetchVideoUrl: trying __a=1&__d=dis: ' + disUrl);
        var disHeaders = defaultHeaders();
        disHeaders['Accept'] = 'application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
        var disResp = http.GET(disUrl, disHeaders, false);
        if (disResp && disResp.isOk && disResp.body) {
            log('fetchVideoUrl: __a=1&__d=dis response length=' + disResp.body.length);
            var disJson = tryParse(disResp.body);
            if (disJson) {
                // Try extracting video_url or video_versions from various response structures
                var vidUrl = extractVideoUrlFromGraphql(disJson);
                if (!vidUrl) {
                    try { vidUrl = disJson.graphql && disJson.graphql.shortcode_media && disJson.graphql.shortcode_media.video_url; } catch {}
                }
                if (!vidUrl) {
                    try { vidUrl = disJson.data && disJson.data.shortcode_media && disJson.data.shortcode_media.video_url; } catch {}
                }
                if (!vidUrl) {
                    try {
                        var item = disJson.items && disJson.items[0];
                        if (item && item.video_versions && item.video_versions.length > 0) vidUrl = item.video_versions[0].url;
                    } catch {}
                }
                if (vidUrl) {
                    log('fetchVideoUrl: found via __a=1&__d=dis');
                    return vidUrl;
                }
            }
            // Try HTML-based extraction
            var htmlVid = extractVideoUrlFromHtml(disResp.body);
            if (htmlVid) {
                log('fetchVideoUrl: found via __a=1&__d=dis HTML');
                return htmlVid;
            }
        }
    } catch (e) {
        log('fetchVideoUrl: __a=1&__d=dis error: ' + e);
    }

    // Strategy 4: Try the embed page (sometimes has media info in lighter format)
    try {
        var embedUrl = API_URLS.base + '/p/' + shortcode + '/embed/';
        log('fetchVideoUrl: trying embed: ' + embedUrl);
        var embedResp = http.GET(embedUrl, defaultHeaders(), false);
        if (embedResp && embedResp.isOk && embedResp.body) {
            // Search for video URL patterns in embed page
            var embedVidMatch = embedResp.body.match(/"video_url"\s*:\s*"([^"]+)"/);
            if (embedVidMatch) {
                var decoded = embedVidMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                log('fetchVideoUrl: found via embed video_url');
                return decoded;
            }
            // Search for contentUrl in LD+JSON
            var embedLd = extractLdVideo(embedResp.body);
            if (embedLd && embedLd.contentUrl) return embedLd.contentUrl;
        }
    } catch (e) {
        log('fetchVideoUrl: embed error: ' + e);
    }

    // Strategy 5: Try the Comet GraphQL API endpoint (different from legacy /graphql/query/)
    try {
        var cometUrl = API_URLS.base + '/api/graphql/';
        var cometBody = JSON.stringify({
            av: '0',
            __d: 'www',
            __user: '0',
            __a: '1',
            __req: '3',
            __hs: '19328.HYP:comet_pkg.2.1.0.0.1',
            dpr: '2',
            __ccg: 'UNKNOWN',
            __rev: '0',
            __s: '4t6xyk:1:1',
            __hsi: '0',
            __dyn: '',
            __csr: '',
            __comet_req: '1',
            fb_dtsg: '',
            jazoest: '',
            lsd: session.lsd || '',
            __spin_r: '0',
            __spin_b: 'trunk',
            __spin_t: '0',
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'PolarisPostActionLoadPostQuery',
            variables: JSON.stringify({ shortcode: shortcode }),
            doc_id: '8847514545173641',
        });
        var cometHeaders = apiHeaders(session.lsd || '', session.mid || '');
        cometHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        cometHeaders['Referer'] = API_URLS.base + '/p/' + shortcode + '/';
        log('fetchVideoUrl: trying Comet GraphQL');
        var cometResp = http.POST(cometUrl, cometBody, cometHeaders, false);
        if (cometResp && cometResp.isOk && cometResp.body) {
            var cometData = tryParse(cometResp.body);
            if (cometData) {
                var vidUrl = extractVideoUrlFromGraphql(cometData);
                if (vidUrl) {
                    log('fetchVideoUrl: found via Comet GraphQL');
                    return vidUrl;
                }
            }
        }
    } catch (e) {
        log('fetchVideoUrl: Comet GraphQL error: ' + e);
    }

    // Strategy 6: Try the oEmbed API endpoint
    try {
        var oembedUrl = 'https://api.instagram.com/oembed?url=' + encodeURIComponent(API_URLS.base + '/p/' + shortcode + '/') + '&format=json';
        log('fetchVideoUrl: trying oEmbed: ' + oembedUrl);
        var oembedResp = http.GET(oembedUrl, defaultHeaders(), false);
        if (oembedResp && oembedResp.isOk && oembedResp.body) {
            var oembedData = tryParse(oembedResp.body);
            if (oembedData && oembedData.thumbnail_url) {
                // oEmbed doesn't give video URL directly, but try finding it
                // Check if html contains an iframe/video source
                if (oembedData.html) {
                    var htmlVid = oembedData.html.match(/src=["']([^"']+\.mp4[^"']*)["']/);
                    if (htmlVid) return htmlVid[1];
                }
            }
        }
    } catch (e) {
        log('fetchVideoUrl: oEmbed error: ' + e);
    }

    // Strategy 7: Kittygram fallback — fetches the individual post page from Kittygram
    try {
        log('fetchVideoUrl: trying Kittygram post fallback');
        var kgPost = fetchKittygramPostData(shortcode);
        if (kgPost && kgPost.videoUrl) {
            log('fetchVideoUrl: found via Kittygram: ' + kgPost.videoUrl.substring(0, 60) + '...');
            return kgPost.videoUrl;
        }
    } catch (e) {
        log('fetchVideoUrl: Kittygram error: ' + e);
    }

    log('fetchVideoUrl: all strategies failed');
    return null;
}

/**
 * Attempts to parse a JSON string, handling Instagram's for(;;); security prefix
 * @param {string} str - Response body to parse
 * @returns {Object|null} Parsed JSON object, or null
 */
function tryParse(str) {
    try {
        if (!str || typeof str !== 'string') return null;
        var cleaned = str;
        // Instagram sometimes prefixes JSON responses with for(;;); to prevent XSSI
        if (cleaned.indexOf('for(;;);') === 0) {
            cleaned = cleaned.substring(8);
        }
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

/**
 * Extracts a video URL from various known Instagram API response structures.
 * Navigates GraphQL, mobile API, and legacy API response formats.
 * @param {Object} data - Parsed API response object
 * @returns {string|null} Video URL, or null
 */
function extractVideoUrlFromGraphql(data) {
    try {
        if (!data) return null;

        var sources = [
            // GraphQL response format: data.shortcode_media.video_url
            function (d) { return d && d.graphql && d.graphql.shortcode_media && d.graphql.shortcode_media.video_url; },
            // Mobile API response format: items[0].video_versions[0].url
            function (d) { return d && d.items && d.items[0] && d.items[0].video_versions && d.items[0].video_versions[0] && d.items[0].video_versions[0].url; },
            // Mobile API with dash manifest (fallback)
            function (d) { return d && d.items && d.items[0] && d.items[0].video_dash_manifest; },
            // Direct GraphQL response (no "graphql" wrapper)
            function (d) { return d && d.shortcode_media && d.shortcode_media.video_url; }
        ];

        var foundUrl = null;
        sources.some(function(fn) {
            var url = fn(data);
            if (url && typeof url === 'string' && (url.indexOf('.mp4') !== -1 || url.indexOf('cdninstagram') !== -1)) {
                foundUrl = url;
                return true;
            }
            return false;
        });

        return foundUrl;
    } catch {
        return null;
    }
}

/**
 * Extracts video URL from HTML by searching for embedded patterns in script data
 * and raw HTML. Handles Instagram's server-rendered React pages where video data
 * may be embedded in script tags or JavaScript strings.
 * @param {string} html - Raw page HTML (may include JSON in script tags)
 * @returns {string|null} Video URL, or null
 */
function extractVideoUrlFromHtml(html) {
    try {
        if (!html || typeof html !== 'string') return null;

        // Pattern 1: Search for video URLs in LD+JSON script tags
        try {
            var ldDoc = domParser.parseFromString(html, 'text/html');
            var ldScripts = ldDoc.querySelectorAll('script[type="application/ld+json"]');
            for (var si = 0; si < ldScripts.length; si++) {
                var ldData = JSON.parse(ldScripts[si].textContent);
                var ldItems = Array.isArray(ldData) ? ldData : [ldData];
                for (var li = 0; li < ldItems.length; li++) {
                    if (ldItems[li]['@type'] === 'VideoObject' || (Array.isArray(ldItems[li]['@type']) && ldItems[li]['@type'].includes('VideoObject'))) {
                        if (ldItems[li].contentUrl) return ldItems[li].contentUrl;
                    }
                }
            }
        } catch {}

        // Pattern 2: Search for HTML5 video sources
        try {
            var vidDoc = domParser.parseFromString(html, 'text/html');
            var videoTags = vidDoc.querySelectorAll('video source[src], video[src]');
            for (var vi = 0; vi < videoTags.length; vi++) {
                var src = videoTags[vi].getAttribute('src');
                if (src) {
                    var decoded = src.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                    if (decoded.indexOf('.mp4') !== -1 || decoded.indexOf('cdninstagram') !== -1)
                        return decoded;
                }
            }
        } catch {}

        // Pattern 3: Regex search for Instagram CDN video URLs in JavaScript strings
        var videoPatterns = [
            /"video_url"\s*:\s*"([^"]+)"/g,
            /"video_versions":\[[^\]]*?"url"\s*:\s*"([^"]+)"/g,
            /contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/g,
            /"downloadUrl"\s*:\s*"([^"]+)"/g
        ];
        for (var pi = 0; pi < videoPatterns.length; pi++) {
            var match;
            while ((match = videoPatterns[pi].exec(html)) !== null) {
                var decoded = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                if (decoded.indexOf('.mp4') !== -1 || decoded.indexOf('cdninstagram') !== -1) {
                    return decoded;
                }
            }
        }

        // Pattern 4: Search for direct CDN URL patterns in HTML
        var cdnPatterns = [
            /https?:\/\/[a-zA-Z0-9.-]*cdninstagram\.com[^"'\s<>]*\.mp4[^"'\s<>]*/g,
            /https?:\/\/[a-zA-Z0-9.-]*fbcdn\.net[^"'\s<>]*\.mp4[^"'\s<>]*/g,
            /https?:\/\/[a-zA-Z0-9.-]*scontent\.cdninstagram\.com[^"'\s<>]*\.mp4[^"'\s<>]*/g
        ];
        for (var cpi = 0; cpi < cdnPatterns.length; cpi++) {
            var cdnMatches = html.match(cdnPatterns[cpi]);
            if (cdnMatches && cdnMatches.length > 0) {
                var decoded = cdnMatches[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                return decoded;
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extracts post metadata from Instagram page HTML by searching for embedded
 * JSON data in script tags and JavaScript strings. Falls back when OG tags
 * and <title> are empty (as is the case with Instagram's skeleton HTML).
 * @param {string} html - Raw page HTML
 * @param {string} shortcode - The post shortcode to match
 * @returns {Object|null} { title, description, thumbnail, author, datetime } or null
 */
function extractPostMetadataFromHtml(html, shortcode) {
    try {
        if (!html || !shortcode) return null;
        var result = { title: '', description: '', thumbnail: '', author: '', datetime: null };
        var found = false;

        // Helper to decode escaped JSON strings
        function decode(str) {
            return str.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\n/g, ' ');
        }

        // Search ALL occurrences of the shortcode in the HTML — the first match
        // might be an <a href> URL context without JSON data nearby. Later matches
        // in __NEXT_DATA__ or _sharedData script tags have richer embedded data.
        try {
            var searchPos = 0;
            while (true) {
                var idx = html.indexOf('"' + shortcode + '"', searchPos);
                if (idx === -1) break;
                var searchStart = Math.max(0, idx - 8000);
                var searchEnd = Math.min(html.length, idx + 8000);
                var context = html.substring(searchStart, searchEnd);

                // Extract caption text from edge_media_to_caption or text fields
                var captionRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                var capMatch;
                while ((capMatch = captionRegex.exec(context)) !== null) {
                    var t = decode(capMatch[1]);
                    if (t.length > result.title.length && t.indexOf('@') !== 0) {
                        result.title = t.substring(0, 100);
                        result.description = t;
                        found = true;
                    }
                }

                // Extract owner username (shorter one near the shortcode)
                var userRegex = /"username"\s*:\s*"([a-zA-Z0-9_.]+)"/g;
                var uMatch;
                while ((uMatch = userRegex.exec(context)) !== null) {
                    if (uMatch[1].length < 50) {
                        result.author = uMatch[1];
                        found = true;
                    }
                }

                // Extract display URL (thumbnail)
                var displayRegex = /"display_url"\s*:\s*"([^"]+)"/g;
                var dMatch;
                while ((dMatch = displayRegex.exec(context)) !== null) {
                    result.thumbnail = decode(dMatch[1]);
                    found = true;
                }

                // Extract thumbnail_src
                var thumbRegex = /"thumbnail_src"\s*:\s*"([^"]+)"/g;
                var tMatch;
                while ((tMatch = thumbRegex.exec(context)) !== null) {
                    if (!result.thumbnail) result.thumbnail = decode(tMatch[1]);
                    found = true;
                }

                // Extract timestamp
                var timeRegex = /"taken_at_timestamp"\s*:\s*(\d+)/g;
                var timeMatch;
                while ((timeMatch = timeRegex.exec(context)) !== null) {
                    result.datetime = parseInt(timeMatch[1]);
                    found = true;
                }

                // Try to find full_name near the shortcode context
                var nameRegex = /"full_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                var nMatch;
                while ((nMatch = nameRegex.exec(context)) !== null) {
                    var fn = decode(nMatch[1]).trim();
                    if (fn && fn.length > 1 && fn.length < 100) {
                        result.author = fn;
                        found = true;
                    }
                }
            }
        } catch {}

        // Fallback: if regex didn't find everything, try LD+JSON script tags
        if (!found) {
            try {
                var ldDoc = domParser.parseFromString(html, 'text/html');
                var ldScripts = ldDoc.querySelectorAll('script[type="application/ld+json"]');
                for (var si2 = 0; si2 < ldScripts.length; si2++) {
                    var ldData = JSON.parse(ldScripts[si2].textContent);
                    var ldItems = Array.isArray(ldData) ? ldData : [ldData];
                    for (var li2 = 0; li2 < ldItems.length; li2++) {
                        var item = ldItems[li2];
                        if (!result.title && item.description) { result.title = item.description.substring(0, 100); result.description = item.description; found = true; }
                        if (!result.author && item.author && item.author.name) { result.author = item.author.name; found = true; }
                        if (!result.thumbnail && (item.thumbnailUrl || item.contentUrl)) { result.thumbnail = item.thumbnailUrl || item.contentUrl; found = true; }
                        if (!result.datetime && item.datePublished) { try { result.datetime = Math.floor(new Date(item.datePublished).getTime() / 1000); } catch {} found = true; }
                    }
                }
            } catch {}
        }

        return found ? result : null;
    } catch {
        return null;
    }
}

/**
 * Extracts channel metadata from profile page HTML by searching for embedded
 * JSON data. Used as fallback when the web API is rate-limited (401).
 * @param {string} html - Raw page HTML
 * @param {string} username - Channel username for matching
 * @returns {Object|null} { name, thumbnail, subscribers } or null
 */
function extractChannelMetadataFromHtml(html, username) {
    try {
        if (!html || !username) return null;
        var result = { name: '', thumbnail: '', subscribers: null };
        var found = false;

        function decode(str) {
            return str.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\n/g, ' ');
        }

        // Search near the username in the HTML for surrounding JSON data
        var idx = html.indexOf('"' + username + '"');
        if (idx === -1) idx = html.indexOf('/' + username + '/');
        if (idx !== -1) {
            var searchStart = Math.max(0, idx - 5000);
            var searchEnd = Math.min(html.length, idx + 5000);
            var context = html.substring(searchStart, searchEnd);

            // Extract full_name
            var nameRegex = /"full_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            var nMatch;
            while ((nMatch = nameRegex.exec(context)) !== null) {
                var fn = decode(nMatch[1]).trim();
                if (fn && fn.length > 1 && fn.length < 100 && fn !== username) {
                    result.name = fn;
                    found = true;
                }
            }

            // Extract profile pic URL
            var picRegex = /"profile_pic_url(_hd)?"\s*:\s*"([^"]+)"/g;
            var pMatch;
            while ((pMatch = picRegex.exec(context)) !== null) {
                result.thumbnail = decode(pMatch[2]);
                found = true;
            }

            // Extract HD profile pic
            var hdRegex = /"profile_pic_url_hd"\s*:\s*"([^"]+)"/g;
            var hMatch;
            while ((hMatch = hdRegex.exec(context)) !== null) {
                result.thumbnail = decode(hMatch[1]);
                found = true;
            }

            // Extract follower count (from edge_followed_by or follower_count)
            var followerRegex = /"edge_followed_by"\s*:\s*\{[^}]*?"count"\s*:\s*(\d+)/g;
            var fMatch;
            while ((fMatch = followerRegex.exec(context)) !== null) {
                result.subscribers = parseInt(fMatch[1]);
                found = true;
            }
            if (!result.subscribers) {
                var countRegex = /"follower_count"\s*:\s*(\d+)/g;
                var cMatch;
                while ((cMatch = countRegex.exec(context)) !== null) {
                    result.subscribers = parseInt(cMatch[1]);
                    found = true;
                }
            }

            // Try biography
            if (!result.name || !result.thumbnail) {
                var bioRegex = /"biography"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                // not used but shows more data is available
            }
        }

        if (!result.name) result.name = username;
        return found ? result : null;
    } catch {
        return null;
    }
}

/**
 * Extracts Instagram shortcodes from page HTML using multiple strategies.
 * Searches for URL patterns, JSON keys, and DOM elements containing post/reel IDs.
 * @param {string} html - Raw page HTML
 * @returns {Array} List of unique shortcode strings
 */
function extractShortcodes(html) {
    var all = [];
    var seen = {};

    // Method 1: Scan raw HTML for /p/CODE and /reel/CODE patterns
    // These appear in JSON data, JS strings, href attributes, or template literals
    var urlRegex = /(?:\/p\/|\/reel\/)([A-Za-z0-9_-]{11,})(?:\/|"|'|`|\s|\\|>)/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
        var code = match[1];
        if (!seen[code]) {
            seen[code] = true;
            all.push(code);
        }
    }

    // Method 2: Search for "code":"XXXXXXXXXXX" patterns (shortened key)
    var codeRegex = /"code"\s*[:=]\s*"([A-Za-z0-9_-]{11,})"/g;
    while ((match = codeRegex.exec(html)) !== null) {
        if (!seen[match[1]]) {
            seen[match[1]] = true;
            all.push(match[1]);
        }
    }

    // Method 3: Search for "shortcode":"XXXXXXXXXXX" patterns
    var scRegex = /"shortcode"\s*[:=]\s*"([A-Za-z0-9_-]{11,})"/g;
    while ((match = scRegex.exec(html)) !== null) {
        if (!seen[match[1]]) {
            seen[match[1]] = true;
            all.push(match[1]);
        }
    }

    // Method 4: Find <a href> elements with post/reel URLs via DOM parsing
    try {
        var doc = domParser.parseFromString(html, 'text/html');
        var links = doc.querySelectorAll('a[href]');
        links.forEach(function(link) {
            var href = link.getAttribute('href');
            if (!href) return;

            var hrefMatch = href.match(/\/(?:p|reel)\/([A-Za-z0-9_-]{11,})/);
            if (hrefMatch && !seen[hrefMatch[1]]) {
                seen[hrefMatch[1]] = true;
                all.push(hrefMatch[1]);
            }
        });
    } catch {}

    // Method 5: Search in __NEXT_DATA__ script (Next.js hydration)
    try {
        var ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
        if (ndMatch) {
            var ndParsed = JSON.parse(ndMatch[1]);
            var ndShortcodes = [];
            // Recursively walk JSON for shortcode fields
            function walkJson(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (Array.isArray(obj)) {
                    for (var wi = 0; wi < obj.length; wi++) walkJson(obj[wi]);
                } else {
                    if (obj.shortcode && typeof obj.shortcode === 'string' && obj.shortcode.length >= 11) ndShortcodes.push(obj.shortcode);
                    if (obj.code && typeof obj.code === 'string' && obj.code.length >= 11) ndShortcodes.push(obj.code);
                    var keys = Object.keys(obj);
                    for (var ki = 0; ki < keys.length; ki++) walkJson(obj[keys[ki]]);
                }
            }
            walkJson(ndParsed);
            for (var ni = 0; ni < ndShortcodes.length; ni++) {
                if (!seen[ndShortcodes[ni]]) {
                    seen[ndShortcodes[ni]] = true;
                    all.push(ndShortcodes[ni]);
                }
            }
        }
    } catch {}
    
    // Method 6: Search in window._sharedData (legacy page data)
    try {
        var sdMatch = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (sdMatch) {
            var sdParsed = JSON.parse(sdMatch[1]);
            var sdShortcodes = [];
            function walkSd(obj) {
                if (!obj || typeof obj !== 'object') return;
                if (Array.isArray(obj)) {
                    for (var wi = 0; wi < obj.length; wi++) walkSd(obj[wi]);
                } else {
                    if (obj.shortcode && typeof obj.shortcode === 'string' && obj.shortcode.length >= 11) sdShortcodes.push(obj.shortcode);
                    if (obj.code && typeof obj.code === 'string' && obj.code.length >= 11) sdShortcodes.push(obj.code);
                    var keys = Object.keys(obj);
                    for (var ki = 0; ki < keys.length; ki++) walkSd(obj[keys[ki]]);
                }
            }
            walkSd(sdParsed);
            for (var ni = 0; ni < sdShortcodes.length; ni++) {
                if (!seen[sdShortcodes[ni]]) {
                    seen[sdShortcodes[ni]] = true;
                    all.push(sdShortcodes[ni]);
                }
            }
        }
    } catch {}

    // Method 7: Search for node.shortcode patterns in minified JS (media edge nodes)
    try {
        var nodeRegex = /node\s*:\s*\{[^}]*?shortcode\s*:\s*"([A-Za-z0-9_-]{11,})"/g;
        var ndMatch;
        while ((ndMatch = nodeRegex.exec(html)) !== null) {
            if (!seen[ndMatch[1]]) {
                seen[ndMatch[1]] = true;
                all.push(ndMatch[1]);
            }
        }
    } catch {}

    return all;
}

/**
 * Extracts VideoObject structured data from LD+JSON script tags
 * @param {string} html - Raw page HTML
 * @returns {Object|null} Parsed VideoObject, or null
 */
function extractLdVideo(html) {
    try {
        const doc = domParser.parseFromString(html, 'text/html');
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');

        for (const script of scripts) {
            const data = JSON.parse(script.textContent);

            // Check for VideoObject type (may be a string or array)
            if (data['@type'] === 'VideoObject' || (Array.isArray(data['@type']) && data['@type'].includes('VideoObject'))) {
                return data;
            }

            // Handle LD+JSON arrays (common when multiple objects are embedded)
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (item['@type'] === 'VideoObject' || (Array.isArray(item['@type']) && item['@type'].includes('VideoObject'))) {
                        return item;
                    }
                }
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extracts ProfilePage data from LD+JSON script tags
 * @param {string} html - Raw page HTML
 * @returns {Object|null} Object with user sub-object, or null
 */
function extractLdProfile(html) {
    try {
        const doc = domParser.parseFromString(html, 'text/html');
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');

        for (const script of scripts) {
            const data = JSON.parse(script.textContent);
            const type = data['@type'];
            const types = Array.isArray(type) ? type : [type];

            if (types.includes('ProfilePage') || types.includes('Person')) {
                const mainEntity = data.mainEntity || data;
                if (mainEntity && (mainEntity['@type'] === 'Person' || types.includes('Person'))) {
                    return {
                        user: {
                            id: mainEntity.identifier || '',
                            username: (mainEntity.alternateName || data.alternateName || data.name || '').toLowerCase(),
                            full_name: mainEntity.name || data.name || '',
                            profile_pic_url: (mainEntity.image && mainEntity.image.url) || data.image || '',
                            biography: mainEntity.description || data.description || ''
                        }
                    };
                }
            }
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extracts Open Graph and standard meta tags from an HTML page
 * @param {string} html - Raw page HTML
 * @returns {Object|null} Object with title, description, image, or null
 */
function extractMetaTags(html) {
    try {
        const doc = domParser.parseFromString(html, 'text/html');
        const metas = doc.querySelectorAll('meta');
        let title = '';
        let description = '';
        let image = '';

        // Extract <title> tag content
        const titleTag = doc.querySelector('title');
        if (titleTag) {
            title = titleTag.textContent || '';
        }

        // Extract meta property and name attributes
        for (const meta of metas) {
            const property = meta.getAttribute('property') || '';
            const name = meta.getAttribute('name') || '';
            const content = meta.getAttribute('content') || '';

            if (property === 'og:title' && !title) title = content;
            if (property === 'og:description' || name === 'description') description = content || description;
            if (property === 'og:image') image = content || image;
        }

        if (!title && !description && !image) return null;

        return { title, description, image };
    } catch {
        return null;
    }
}

/**
 * Searches for video or image URLs in the page HTML.
 * Looks for preload links, og:video meta tags, and og:image as fallback.
 * @param {string} html - Raw page HTML
 * @returns {string|null} URL string, or null
 */
function extractScreenshotVideo(html) {
    try {
        const doc = domParser.parseFromString(html, 'text/html');

        // Look for preloaded video links
        const links = doc.querySelectorAll('link[rel="preload"][as="video"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href) return href;
        }

        // Look for og:video meta tag
        const metaOgVideo = doc.querySelector('meta[property="og:video"]');
        if (metaOgVideo) {
            const content = metaOgVideo.getAttribute('content');
            if (content) return content;
        }

        // Fall back to og:image
        const metaOgImage = doc.querySelector('meta[property="og:image"]');
        if (metaOgImage) {
            const content = metaOgImage.getAttribute('content');
            if (content) return content;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extracts the username from an Instagram profile URL
 * @param {string} url - Full Instagram URL (e.g. https://www.instagram.com/username/)
 * @returns {string|null} Username, or null
 */
function extractUsername(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.replace(/\/$/, '');
        const parts = pathname.split('/').filter(Boolean);
        return parts.length > 0 ? parts[0] : null;
    } catch {
        return null;
    }
}

/**
 * Parses ISO 8601 duration string (e.g. PT1M30S) into total seconds
 * @param {string} iso - ISO 8601 duration string
 * @returns {number|null} Total seconds, or null
 */
function parseDurationIso(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const match = iso.match(/^PT(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!match) return null;
    const minutes = parseInt(match[1]) || 0;
    const seconds = parseInt(match[2]) || 0;
    return minutes * 60 + seconds;
}

/**
 * Parse a "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS" datetime string to a Unix
 * timestamp in seconds WITHOUT relying on new Date(), which may return NaN in some
 * JS engines (e.g. Grayjay's embedded runtime).
 * @param {string} str - datetime string
 * @returns {number|null} Unix seconds, or null if unparseable
 */
function parseDatetimeToUnix(str) {
    if (!str || typeof str !== 'string') return null;
    var m = str.match(/^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10) - 1; // 0-based
    var day = parseInt(m[3], 10);
    var hour = parseInt(m[4], 10);
    var min = parseInt(m[5], 10);
    var sec = parseInt(m[6], 10);
    // Days since Unix epoch (1970-01-01) using the proleptic Gregorian calendar
    var a = Math.floor((14 - (month + 1)) / 12);
    var y = year + 4800 - a;
    var mo = (month + 1) + 12 * a - 3;
    var jdn = day + Math.floor((153 * mo + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    var unixDays = jdn - 2440588; // JDN of 1970-01-01
    return unixDays * 86400 + hour * 3600 + min * 60 + sec;
}

/**
 * Custom CommentPager with pagination support
 */
class InstagramCommentPager extends CommentPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        if (!this.hasMore || !this.context || !this.context.shortcode) {
            return new InstagramCommentPager([], false, this.context);
        }
        return source.getComments(API_URLS.base + '/p/' + this.context.shortcode + '/');
    }
}

/**
 * Pagination pager for Instagram channel feeds.
 * Stores cursor context and fetches the next page on demand.
 */
class InstagramVideoPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
    }

    nextPage() {
        return source.getChannelContents(
            API_URLS.base + '/' + encodeURIComponent(this.context.username) + '/',
            this.context.wantShorts ? Type.Feed.Shorts : Type.Feed.Mixed,
            Type.Order.Chronological,
            null,
            this.context.cursor
        );
    }
}
