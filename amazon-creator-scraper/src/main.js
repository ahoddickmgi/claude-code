/**
 * Amazon Creator Connections ASIN Scraper
 *
 * Logs in to Amazon Associates and scrapes all active campaigns from the
 * Creator Connections portal, collecting each campaign's ASINs and metadata.
 *
 * Input fields (see ../.actor/input_schema.json):
 *   email            – Associates account email
 *   password         – Associates account password
 *   otpSecret        – Optional TOTP code for 2FA
 *   creatorId        – Your amzn1.creator.xxx ID (auto-detected if omitted)
 *   maxCampaigns     – Cap on campaigns scraped (0 = unlimited)
 *   scrapeAsinDetails– Navigate into each campaign for full ASIN list
 *   categories       – Only return campaigns matching these category keywords
 *   proxyConfiguration
 *   sessionCookies   – Pre-authenticated cookies (skips login)
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';
import { TOTP } from 'otplib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://affiliate-program.amazon.com';
const ASIN_REGEX = /\b(B[0-9A-Z]{9}|[0-9]{10})\b/g;

// The actual URL pattern used by the Creator Connections portal.
// creatorId is user-specific and is extracted automatically after login.
const REQUESTS_PATH = '/p/connect/requests';

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Builds the Creator Connections URL with the correct query parameters.
 * The `categories` param can hold a comma-separated list for server-side filtering.
 */
function buildCreatorConnectionsUrl(creatorId, categoryFilter = []) {
    const params = new URLSearchParams({
        creatorId,
        status: 'opportunity',
        type: 'affiliate-plus',
        sortBy: 'recommended_for_you',
        keyword: '',
        filterExpanderStatus: 'false',
        categories: categoryFilter.join(','),
        nonFullyClaimedOnly: 'false',
        campaignStatuses: 'active,pending',
        topBrandsOnly: 'false',
        creatorFavoritesOnly: 'false',
        brands: '',
        contentType: '',
        budgetAvailability: '',
    });
    return `${BASE_URL}${REQUESTS_PATH}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function isOnLoginPage(page) {
    const url = page.url();
    return (
        url.includes('/ap/signin') ||
        url.includes('/ap/mfa') ||
        url.includes('/ap/cvf') ||
        url.includes('signin')
    );
}

/**
 * Waits until the browser has left all Amazon login/auth pages.
 * More permissive than waiting for a specific hostname — Amazon may land on
 * amazon.com, amazon.com/associates, or affiliate-program.amazon.com after login.
 */
async function waitForLoginComplete(page, timeoutMs = 45_000) {
    await page.waitForFunction(
        () => {
            const url = window.location.href;
            return (
                !url.includes('/ap/signin') &&
                !url.includes('/ap/mfa') &&
                !url.includes('/ap/cvf') &&
                !url.includes('/ap/challenge') &&
                !url.includes('signin?') &&
                !url.includes('sign-in')
            );
        },
        { timeout: timeoutMs },
    );
    log.info(`Post-login URL: ${page.url()}`);
}

/**
 * Detects and fills an OTP/TOTP input if one is present on the page.
 * Handles TOTP authenticator apps by generating the current code from the secret.
 */
async function handleOtpIfPresent(page, otpSecret) {
    const otpInput = page.locator([
        'input[name="otpCode"]',
        'input[id="auth-mfa-otpcode"]',
        'input[id*="otp"]',
        'input[id*="mfa"]',
        'input[id*="cvf"]',
        'input[name="code"]',
        'input[type="tel"]',
        'input[id="cvf-input-code"]',
    ].join(', ')).first();

    if (!await otpInput.isVisible({ timeout: 12_000 }).catch(() => false)) return true;

    if (!otpSecret) {
        log.warning(
            'Amazon is requesting a 2FA / OTP code but none was provided. ' +
            'Supply the TOTP secret key via the "otpSecret" input field.',
        );
        await Actor.setValue('debug_otp_prompt', await page.screenshot(), { contentType: 'image/png' });
        return false;
    }

    const totp = new TOTP();
    const code = totp.generate(otpSecret.replace(/\s/g, '').toUpperCase());
    log.info(`Entering TOTP code (${code})…`);
    await otpInput.fill(code);
    await page.locator('input[type="submit"], button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded');
    log.info(`After TOTP submission: ${page.url()}`);
    return true;
}

/**
 * Completes the Amazon login flow starting from wherever the page currently is.
 * Works whether we navigated here ourselves or were redirected by Amazon.
 */
async function completeLoginFlow(page, { email, password, otpSecret, openIdUrl = null }) {
    // Click any "Sign in" link on the Associates landing page if present.
    const signInLink = page.locator('a[href*="signin"], a:has-text("Sign in"), button:has-text("Sign in")').first();
    if (await signInLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await signInLink.click();
        await page.waitForLoadState('domcontentloaded');
    }

    // Email step.
    if (await page.locator('#ap_email').isVisible({ timeout: 8_000 }).catch(() => false)) {
        log.info('Entering email…');
        await page.fill('#ap_email', email);
        await page.click('#continue');
        await page.waitForLoadState('domcontentloaded');
    }

    // Password step.
    if (await page.locator('#ap_password').isVisible({ timeout: 8_000 }).catch(() => false)) {
        log.info('Entering password…');
        await page.fill('#ap_password', password);
        await page.click('#signInSubmit');
        await page.waitForLoadState('domcontentloaded');
    }

    // Save a screenshot immediately after the password submit so we can see
    // whatever Amazon shows next (OTP prompt, CAPTCHA, notification, etc.).
    await Actor.setValue('debug_post_login', await page.screenshot(), { contentType: 'image/png' });

    // OTP / 2FA step — handled by the shared helper.
    // Returns false if OTP was detected but secret not provided (skip waitForLoginComplete).
    const otpOk = await handleOtpIfPresent(page, otpSecret);
    if (!otpOk) {
        log.warning('Cannot proceed past OTP prompt — add "otpSecret" to actor input and re-run.');
        return;
    }
    // interstitial mid-way through the OpenID redirect chain.
    if (page.url().includes('gp/help') || page.url().includes('condition_of_use')) {
        log.info('Conditions of Use page detected — saving screenshot and HTML…');
        await Actor.setValue('debug_cou_page', await page.screenshot(), { contentType: 'image/png' });
        await Actor.setValue('debug_cou_html', await page.content(), { contentType: 'text/html' });

        // The CoU page is a static Amazon help page (gp/help/customer/display.html).
        // It has NO Accept/Continue button for the OpenID flow — only the site-wide
        // Amazon search bar submit button (which sends us to amazon.com/).
        // DO NOT click any generic submit button here.
        //
        // If we know the OpenID login URL (supplied by the caller), revisiting it
        // after a successful credential submission may trigger a silent re-auth:
        // Amazon records authentication at form-submit time and a subsequent visit
        // to the same OpenID URL within max_auth_age should redirect straight to
        // return_to without showing the form again.
        if (openIdUrl && openIdUrl.includes('openid')) {
            log.info('Revisiting OpenID URL for silent re-auth…');
            await page.goto(openIdUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            log.info(`After OpenID URL revisit: ${page.url()}`);
            // If Amazon still shows a login form, fill it in one more time.
            if (await page.locator('#ap_email, #ap_password').first().isVisible({ timeout: 5_000 }).catch(() => false)) {
                log.info('Silent re-auth requires credentials — filling form again…');
                if (await page.locator('#ap_email').isVisible({ timeout: 3_000 }).catch(() => false)) {
                    await page.fill('#ap_email', email);
                    await page.click('#continue');
                    await page.waitForLoadState('domcontentloaded');
                }
                if (await page.locator('#ap_password').isVisible({ timeout: 5_000 }).catch(() => false)) {
                    await page.fill('#ap_password', password);
                    await page.click('#signInSubmit');
                    await page.waitForLoadState('domcontentloaded');
                }
                // Handle TOTP after password — Amazon prompts for it even in re-auth flows.
                const reAuthOtpOk = await handleOtpIfPresent(page, otpSecret);
                if (!reAuthOtpOk) {
                    log.warning('Cannot proceed past OTP prompt in re-auth — add "otpSecret" to actor input.');
                    return;
                }
                await waitForLoginComplete(page);
                log.info(`After second credentials fill: ${page.url()}`);
            }
        } else {
            // No OpenID URL — fall back to navigating to the Associates home.
            log.info('Navigating to Associates home to resume OpenID session…');
            await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
            log.info(`After CoU → BASE_URL: ${page.url()}`);
        }
    }

    log.info(`Login complete. Final URL: ${page.url()}`);
}

async function loginToAmazonAssociates(page, { email, password, otpSecret }) {
    log.info('Navigating to Amazon Associates login…');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    if (!await isOnLoginPage(page) && page.url().includes('affiliate-program.amazon.com')) {
        log.info('Session already authenticated – skipping login.');
        return;
    }

    await completeLoginFlow(page, { email, password, otpSecret });

    // Make sure we land on the Associates portal before proceeding.
    if (!page.url().includes('affiliate-program.amazon.com')) {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    }
}

// ---------------------------------------------------------------------------
// creatorId detection
// ---------------------------------------------------------------------------

/**
 * Navigates to the Creator Connections landing page and extracts the
 * creatorId from any URL or anchor that contains it.
 */
async function detectCreatorId(page) {
    log.info('Auto-detecting creatorId…');

    // First try: navigate to the landing page and watch for a redirect or link
    // that contains the creatorId query param.
    await page.goto(`${BASE_URL}${REQUESTS_PATH}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    // Check the current URL first (page may have redirected with creatorId).
    let creatorId = new URL(page.url()).searchParams.get('creatorId');
    if (creatorId) {
        log.info(`creatorId found in page URL: ${creatorId}`);
        return creatorId;
    }

    // Search the page HTML for the creatorId pattern.
    creatorId = await page.evaluate(() => {
        const pattern = /amzn1\.creator\.[a-z0-9-]+/i;
        // Check all anchor hrefs and script content.
        for (const el of document.querySelectorAll('a[href], [data-creator-id]')) {
            const src = el.getAttribute('href') || el.getAttribute('data-creator-id') || '';
            const match = src.match(pattern);
            if (match) return match[0];
        }
        // Scan the full page source as a last resort.
        const bodyMatch = document.documentElement.innerHTML.match(pattern);
        return bodyMatch ? bodyMatch[0] : null;
    });

    if (creatorId) {
        log.info(`creatorId found in page source: ${creatorId}`);
        return creatorId;
    }

    // Also try the Associates home page.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    creatorId = await page.evaluate(() => {
        const pattern = /amzn1\.creator\.[a-z0-9-]+/i;
        const bodyMatch = document.documentElement.innerHTML.match(pattern);
        return bodyMatch ? bodyMatch[0] : null;
    });

    if (creatorId) {
        log.info(`creatorId found on Associates home: ${creatorId}`);
        return creatorId;
    }

    throw new Error(
        'Could not auto-detect your creatorId. Please supply it manually via the "creatorId" input field. ' +
        'You can find it in the URL when you visit the Creator Connections page in your browser: ' +
        'look for "creatorId=amzn1.creator.xxxx" in the address bar.',
    );
}

// ---------------------------------------------------------------------------
// API response interception
// ---------------------------------------------------------------------------

/**
 * Sets up a listener that captures XHR/fetch responses from the campaigns API.
 * Amazon's Creator Connections page fetches campaign data as JSON — intercepting
 * this is more reliable than scraping the rendered DOM.
 *
 * Returns a getter function: call it to retrieve all captured campaign arrays.
 */
function setupApiInterceptor(page) {
    const captured = [];

    page.on('response', async (response) => {
        const url = response.url();
        // Target the internal API endpoints that serve campaign/opportunity data.
        if (
            url.includes('/p/connect/') ||
            url.includes('/associate/') ||
            url.includes('creatorConnections') ||
            url.includes('opportunities') ||
            url.includes('campaigns') ||
            url.includes('promotions')
        ) {
            const ct = response.headers()['content-type'] ?? '';
            if (!ct.includes('application/json')) return;
            try {
                const json = await response.json();
                captured.push({ url, json });
                log.debug(`Captured API response from: ${url}`);
            } catch {
                // Not valid JSON or already consumed — ignore.
            }
        }
    });

    return () => captured;
}

/**
 * Tries to extract campaign records from captured API responses.
 * Amazon's response schema varies; this handles several known shapes.
 */
function extractCampaignsFromApiResponses(responses) {
    const campaigns = [];

    for (const { url, json } of responses) {
        // Try common response envelope shapes.
        const candidates = [
            json,
            json?.data,
            json?.result,
            json?.results,
            json?.opportunities,
            json?.campaigns,
            json?.promotions,
            json?.items,
            json?.content,
        ].filter(Boolean);

        for (const candidate of candidates) {
            const arr = Array.isArray(candidate) ? candidate : null;
            if (!arr || arr.length === 0) continue;

            // Validate that the array looks like campaign objects.
            const first = arr[0];
            if (typeof first !== 'object') continue;

            log.info(`Extracting ${arr.length} campaign(s) from API response: ${url}`);

            for (const item of arr) {
                const asins = extractAsinsFromObject(item);
                campaigns.push({
                    campaignId: item.campaignId ?? item.id ?? item.promotionId ?? null,
                    brandName: item.brandName ?? item.brand?.name ?? item.sellerName ?? null,
                    campaignTitle: item.title ?? item.campaignTitle ?? item.name ?? null,
                    category: item.category ?? item.categoryName ?? item.productCategory ?? null,
                    commissionRate:
                        item.commissionRate ?? item.commission ?? item.bountyRate ?? null,
                    startDate: item.startDate ?? item.campaignStartDate ?? null,
                    endDate: item.endDate ?? item.campaignEndDate ?? null,
                    description: item.description ?? item.campaignDescription ?? null,
                    detailLink: item.detailUrl ?? item.url ?? item.landingPageUrl ?? null,
                    asins,
                    asinCount: asins.length,
                    rawApiData: item,
                    scrapedAt: new Date().toISOString(),
                });
            }

            // Stop after the first matching array shape.
            break;
        }
    }

    return campaigns;
}

/**
 * Recursively walks a JSON object and collects any ASIN-shaped strings.
 */
function extractAsinsFromObject(obj, depth = 0) {
    if (depth > 6) return [];
    const asins = new Set();

    const scan = (val) => {
        if (typeof val === 'string') {
            for (const m of val.matchAll(ASIN_REGEX)) asins.add(m[0]);
        } else if (Array.isArray(val)) {
            for (const v of val) scan(v);
        } else if (val && typeof val === 'object') {
            // Shortcut: if there's an explicit asin/ASIN key, use it.
            const direct = val.asin ?? val.ASIN ?? val.itemAsin ?? val.productAsin;
            if (direct && /^B[0-9A-Z]{9}$|^[0-9]{10}$/.test(direct)) {
                asins.add(direct);
            }
            for (const v of Object.values(val)) scan(v);
        }
    };

    scan(obj);
    return [...asins];
}

// ---------------------------------------------------------------------------
// ASIN helpers
// ---------------------------------------------------------------------------

function extractAsins(text) {
    const matches = text.match(ASIN_REGEX) ?? [];
    return [...new Set(matches)];
}

function parseCommission(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return `${raw}%`;
    const match = String(raw).match(/[\d.]+\s*%/);
    return match ? match[0].trim() : String(raw).trim();
}

// ---------------------------------------------------------------------------
// DOM fallback scraping
// ---------------------------------------------------------------------------

async function scrollToLoadAllCampaigns(page) {
    let previousHeight = 0;
    for (let i = 0; i < 20; i++) {
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) break;
        previousHeight = currentHeight;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1500);
    }
}

async function clickLoadMoreUntilDone(page) {
    const loadMoreSelectors = [
        'button:has-text("Load more")',
        'button:has-text("Show more")',
        'a:has-text("Next")',
        '[data-testid="load-more"]',
        '.pagination-next',
    ];

    for (let i = 0; i < 50; i++) {
        let clicked = false;
        for (const sel of loadMoreSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
                await btn.click();
                await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
                clicked = true;
                break;
            }
        }
        if (!clicked) break;
        await sleep(1000);
    }
}

/**
 * DOM-based card parser — used only when API interception yields nothing.
 */
async function parseCampaignCardsFromDom(page) {
    return page.evaluate(() => {
        const campaigns = [];

        // Try selectors from most to least specific.
        const cardSelectors = [
            '[data-testid="campaign-card"]',
            '[data-testid="opportunity-card"]',
            '[class*="CampaignCard"]',
            '[class*="campaign-card"]',
            '[class*="OpportunityCard"]',
            '[class*="opportunity-card"]',
            '[class*="RequestCard"]',
            '[class*="request-card"]',
            '[class*="promotionCard"]',
            '[class*="PromotionCard"]',
            'article',
            '.promotion-item',
        ];

        let cards = [];
        for (const sel of cardSelectors) {
            cards = [...document.querySelectorAll(sel)];
            if (cards.length > 0) break;
        }

        for (const card of cards) {
            const getText = (sel) => card.querySelector(sel)?.textContent?.trim() ?? null;
            const getAttr = (sel, attr) => card.querySelector(sel)?.getAttribute(attr) ?? null;

            const cardText = card.innerText ?? card.textContent ?? '';
            const asinMatches = cardText.match(/\b(B[0-9A-Z]{9}|[0-9]{10})\b/g) ?? [];
            const asins = [...new Set(asinMatches)];

            const campaignId =
                card.dataset.campaignId ??
                card.dataset.id ??
                card.dataset.promotionId ??
                card.dataset.opportunityId ??
                getAttr('a', 'href')?.match(/[?&](?:id|campaignId|opportunityId)=([^&]+)/)?.[1] ??
                null;

            campaigns.push({
                campaignId,
                detailLink: card.querySelector('a')?.href ?? null,
                brandName:
                    getText('[class*="brand"]') ?? getText('[class*="Brand"]') ?? null,
                campaignTitle:
                    getText('h2') ?? getText('h3') ??
                    getText('[class*="title"]') ?? getText('[class*="Title"]') ?? null,
                commissionRate:
                    getText('[class*="commission"]') ?? getText('[class*="Commission"]') ??
                    getText('[class*="rate"]') ?? null,
                startDate: getText('[class*="startDate"]') ?? getText('[class*="start-date"]') ?? null,
                endDate: getText('[class*="endDate"]') ?? getText('[class*="end-date"]') ?? null,
                description:
                    getText('[class*="description"]') ?? getText('[class*="Description"]') ?? null,
                category:
                    getText('[class*="category"]') ?? getText('[class*="Category"]') ??
                    getText('[data-testid*="category"]') ??
                    getText('[class*="tag"]') ?? getText('[class*="Tag"]') ?? null,
                asinsFromCard: asins,
                rawCardText: cardText.substring(0, 500),
            });
        }

        return campaigns;
    });
}

// ---------------------------------------------------------------------------
// Category filter (keyword fallback)
// ---------------------------------------------------------------------------

function matchesCategories(campaign, categories) {
    if (!categories || categories.length === 0) return true;
    const haystack = [
        campaign.category,
        campaign.campaignTitle,
        campaign.description,
        campaign.brandName,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return categories.some((cat) => haystack.includes(cat.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Detail page ASIN scraping
// ---------------------------------------------------------------------------

async function scrapeCampaignAsins(page) {
    const asins = new Set();

    const asinElements = await page.$$('[data-asin]');
    for (const el of asinElements) {
        const asin = await el.getAttribute('data-asin');
        if (asin && /^B[0-9A-Z]{9}$|^[0-9]{10}$/.test(asin.trim())) {
            asins.add(asin.trim());
        }
    }

    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const asin of extractAsins(bodyText)) asins.add(asin);

    return [...asins];
}

// ---------------------------------------------------------------------------
// Main Actor Entry Point
// ---------------------------------------------------------------------------

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    email = '',
    password = '',
    otpSecret = '',
    creatorId: creatorIdInput = '',
    maxCampaigns = 0,
    scrapeAsinDetails = true,
    categories = [],
    proxyConfiguration: proxyConfig,
    sessionCookies = [],
} = input;

const categoryFilter = categories.map((c) => c.trim()).filter(Boolean);

if (!sessionCookies.length && (!email || !password)) {
    throw new Error(
        'You must provide either "email" + "password", or pre-authenticated "sessionCookies" in the actor input.',
    );
}

const proxy = proxyConfig ? await Actor.createProxyConfiguration(proxyConfig) : undefined;
const dataset = await Actor.openDataset();

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxy,
    headless: true,
    launchContext: {
        launchOptions: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            });
        },
    ],

    async requestHandler({ page, request }) {
        if (request.label !== 'LOGIN') return;

        // ------------------------------------------------------------------
        // Step 1: Authenticate
        // ------------------------------------------------------------------
        if (sessionCookies.length > 0) {
            log.info(`Injecting ${sessionCookies.length} session cookies…`);
            await page.context().addCookies(sessionCookies);
            // Navigate to Associates home and wait for full JS execution so that
            // session tokens needed for /p/connect/ routes are properly initialised.
            log.info('Warming Associates session after cookie injection…');
            await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
            await sleep(2000);
            log.info(`Associates home URL: ${page.url()}`);
        } else {
            await loginToAmazonAssociates(page, { email, password, otpSecret });
        }

        // ------------------------------------------------------------------
        // Step 2: Resolve creatorId
        // ------------------------------------------------------------------
        const creatorId = creatorIdInput.trim() || await detectCreatorId(page);
        log.info(`Using creatorId: ${creatorId}`);

        // ------------------------------------------------------------------
        // Step 3: Set up API response interception, then navigate
        // ------------------------------------------------------------------
        const getApiResponses = setupApiInterceptor(page);

        const targetUrl = buildCreatorConnectionsUrl(creatorId, categoryFilter);
        log.info(`Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

        // Amazon sometimes redirects deep URLs back to sign-in even when the
        // Associates home loaded fine.  Detect and complete login if that happens.
        if (await isOnLoginPage(page)) {
            log.info('Redirected to login page — completing login flow…');
            if (!email || !password) {
                throw new Error(
                    'Amazon redirected to the login page but no email/password were provided. ' +
                    'Add "email" and "password" to the actor input so the scraper can log in.',
                );
            }
            // Capture the OpenID URL before consuming it — we'll pass it to
            // completeLoginFlow so it can attempt a silent re-auth after any
            // Conditions of Use interstitial by revisiting this URL.
            const openIdLoginUrl = page.url();
            await completeLoginFlow(page, { email, password, otpSecret, openIdUrl: openIdLoginUrl });

            log.info(`Post-login URL: ${page.url()}`);

            if (page.url().includes('/p/connect/requests')) {
                log.info('OpenID flow completed — on target URL.');
            } else {
                // Ensure we land on the Associates portal before attempting further navigation.
                if (!page.url().startsWith(BASE_URL)) {
                    log.info('Navigating to Associates home…');
                    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
                    await sleep(2000);
                    log.info(`Associates home URL: ${page.url()}`);
                }

                await Actor.setValue('debug_associates_home', await page.screenshot(), { contentType: 'image/png' });

                if (!page.url().includes('/p/connect/requests')) {
                    // Try to find and click a Creator Connections nav link.
                    const navSelectors = [
                        'a[href*="/p/connect"]',
                        'a:has-text("Creator Connections")',
                        'li:has-text("Creator Connections") a',
                        '[data-testid*="creator"] a',
                        'nav a[href*="connect"]',
                        'a[href*="creator-connections"]',
                    ];
                    let navigated = false;
                    for (const sel of navSelectors) {
                        const link = page.locator(sel).first();
                        if (await link.isVisible({ timeout: 2_000 }).catch(() => false)) {
                            const href = await link.getAttribute('href').catch(() => '');
                            log.info(`Clicking nav link (${sel}): ${href}`);
                            await link.click();
                            await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
                            await sleep(3000);
                            log.info(`URL after clicking nav link: ${page.url()}`);
                            navigated = true;
                            break;
                        }
                    }

                    if (!navigated && !page.url().includes('/p/connect/requests')) {
                        // Last resort: direct page.goto to the target URL.
                        log.info('No nav link found — attempting direct navigation to target URL…');
                        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
                        log.info(`URL after direct goto: ${page.url()}`);
                    }
                }
            }
        }

        log.info('Waiting for Creator Connections page to load…');
        log.info(`Current URL before networkidle: ${page.url()}`);
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        await sleep(3000);
        log.info(`Current URL after networkidle: ${page.url()}`);

        // ------------------------------------------------------------------
        // Step 4: Scroll / paginate to trigger all lazy-loaded API calls
        // ------------------------------------------------------------------
        log.info('Scrolling to load all campaigns…');
        await scrollToLoadAllCampaigns(page);
        await clickLoadMoreUntilDone(page);
        // Extra wait after scrolling to let final API calls resolve.
        await sleep(2000);

        // ------------------------------------------------------------------
        // Step 5: Extract campaigns — prefer API data, fall back to DOM
        // ------------------------------------------------------------------
        let campaigns = extractCampaignsFromApiResponses(getApiResponses());

        if (campaigns.length === 0) {
            log.info('No API responses captured — falling back to DOM scraping…');
            const domCampaigns = await parseCampaignCardsFromDom(page);
            log.info(`DOM parser found ${domCampaigns.length} card(s).`);

            if (domCampaigns.length === 0) {
                log.warning('No campaigns found. Saving debug snapshot.');
                await Actor.setValue('debug_page_html', await page.content(), { contentType: 'text/html' });
                await Actor.setValue('debug_screenshot', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                return;
            }

            // Convert DOM cards to the unified campaign shape.
            campaigns = domCampaigns.map((c) => ({
                campaignId: c.campaignId,
                brandName: c.brandName,
                campaignTitle: c.campaignTitle,
                category: c.category,
                commissionRate: c.commissionRate,
                startDate: c.startDate,
                endDate: c.endDate,
                description: c.description,
                detailLink: c.detailLink,
                asins: c.asinsFromCard,
                asinCount: c.asinsFromCard.length,
                rawApiData: null,
                scrapedAt: new Date().toISOString(),
                _source: 'dom',
            }));
        } else {
            log.info(`API interception yielded ${campaigns.length} campaign(s).`);
        }

        // ------------------------------------------------------------------
        // Step 6: Keyword category filter (catches anything the URL param missed)
        // ------------------------------------------------------------------
        if (categoryFilter.length > 0) {
            const before = campaigns.length;
            campaigns = campaigns.filter((c) => matchesCategories(c, categoryFilter));
            log.info(`Category filter matched ${campaigns.length}/${before} campaign(s).`);
        }

        // ------------------------------------------------------------------
        // Step 7: Respect maxCampaigns cap
        // ------------------------------------------------------------------
        const limit = maxCampaigns > 0 ? maxCampaigns : campaigns.length;
        const toProcess = campaigns.slice(0, limit);

        // ------------------------------------------------------------------
        // Step 8: Optional detail-page drill-down for full ASIN list
        // ------------------------------------------------------------------
        for (const [i, campaign] of toProcess.entries()) {
            log.info(`Processing campaign ${i + 1}/${toProcess.length}: "${campaign.campaignTitle}"`);

            let asins = campaign.asins;

            if (scrapeAsinDetails && campaign.detailLink) {
                try {
                    await page.goto(campaign.detailLink, { waitUntil: 'domcontentloaded' });
                    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
                    await sleep(1500);

                    const expandBtns = [
                        'button:has-text("View all")',
                        'button:has-text("Show all")',
                        'button:has-text("See all products")',
                        '[data-testid="view-all-products"]',
                    ];
                    for (const sel of expandBtns) {
                        const btn = page.locator(sel).first();
                        if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
                            await btn.click();
                            await sleep(1000);
                        }
                    }

                    const detailAsins = await scrapeCampaignAsins(page);
                    asins = [...new Set([...asins, ...detailAsins])];
                    log.info(`  → ${asins.length} ASIN(s) after detail page.`);
                } catch (err) {
                    log.warning(`  → Detail page failed (${err.message}). Using existing ASINs.`);
                }
            }

            await dataset.pushData({
                campaignId: campaign.campaignId,
                brandName: campaign.brandName,
                campaignTitle: campaign.campaignTitle,
                category: campaign.category ?? null,
                commissionRate: parseCommission(campaign.commissionRate),
                startDate: campaign.startDate,
                endDate: campaign.endDate,
                description: campaign.description,
                detailLink: campaign.detailLink,
                asins,
                asinCount: asins.length,
                scrapedAt: new Date().toISOString(),
            });

            await sleep(600 + Math.random() * 600);
        }

        log.info(`Done. Saved ${toProcess.length} campaigns to the dataset.`);
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    },
});

await crawler.run([
    {
        url: BASE_URL,
        label: 'LOGIN',
        uniqueKey: `login-${Date.now()}`,
    },
]);

await Actor.exit();
