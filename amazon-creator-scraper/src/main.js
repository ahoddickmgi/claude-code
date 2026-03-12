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
 *   maxCampaigns     – Cap on campaigns scraped (0 = unlimited)
 *   scrapeAsinDetails– Navigate into each campaign for full ASIN list
 *   categories       – Only return campaigns matching these category keywords
 *   proxyConfiguration
 *   sessionCookies   – Pre-authenticated cookies (skips login)
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://affiliate-program.amazon.com';
const CREATOR_CONNECTIONS_URL = `${BASE_URL}/home/promotions/creator-connections`;
const AMAZON_SIGN_IN_URL = 'https://www.amazon.com/ap/signin';
const ASIN_REGEX = /\b(B[0-9A-Z]{9}|[0-9]{10})\b/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether the current page is still an Amazon login/auth page.
 */
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
 * Waits for the Associates dashboard to appear after login.
 */
async function waitForAssociatesDashboard(page, timeoutMs = 30_000) {
    await page.waitForFunction(
        () => window.location.hostname.includes('affiliate-program.amazon.com'),
        { timeout: timeoutMs },
    );
}

/**
 * Performs the full Amazon Associates login flow.
 * Handles: email → password → optional OTP/2FA.
 */
async function loginToAmazonAssociates(page, { email, password, otpSecret }) {
    log.info('Navigating to Amazon Associates login…');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // If already authenticated, skip login.
    if (!await isOnLoginPage(page) && page.url().includes('affiliate-program.amazon.com')) {
        log.info('Session already authenticated – skipping login.');
        return;
    }

    // Click the Sign-In link if present on the Associates landing page.
    const signInLink = page.locator('a[href*="signin"], a:has-text("Sign in"), button:has-text("Sign in")').first();
    if (await signInLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await signInLink.click();
        await page.waitForLoadState('domcontentloaded');
    }

    // --- Email step ---
    log.info('Entering email…');
    await page.waitForSelector('#ap_email', { timeout: 15_000 });
    await page.fill('#ap_email', email);
    await page.click('#continue');
    await page.waitForLoadState('domcontentloaded');

    // --- Password step ---
    log.info('Entering password…');
    await page.waitForSelector('#ap_password', { timeout: 15_000 });
    await page.fill('#ap_password', password);
    await page.click('#signInSubmit');
    await page.waitForLoadState('domcontentloaded');

    // --- OTP / 2FA step (optional) ---
    const otpInput = page.locator('input[name="otpCode"], input[id*="otp"], input[id*="mfa"]').first();
    if (await otpInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
        if (!otpSecret) {
            throw new Error(
                'Amazon is requesting a 2FA / OTP code but none was provided in the input. ' +
                'Supply the current TOTP code via the "otpSecret" input field.',
            );
        }
        log.info('Entering OTP / 2FA code…');
        await otpInput.fill(otpSecret);
        const otpSubmit = page.locator('input[type="submit"], button[type="submit"]').first();
        await otpSubmit.click();
        await page.waitForLoadState('domcontentloaded');
    }

    // Wait until we land on the Associates portal.
    await waitForAssociatesDashboard(page);
    log.info('Login successful.');
}

/**
 * Extracts all ASINs found in a text string.
 */
function extractAsins(text) {
    const matches = text.match(ASIN_REGEX) ?? [];
    return [...new Set(matches)]; // deduplicate
}

/**
 * Parses a commission-rate string like "5%" or "5.00%" into a clean string.
 */
function parseCommission(raw) {
    if (!raw) return null;
    const match = raw.match(/[\d.]+\s*%/);
    return match ? match[0].trim() : raw.trim();
}

/**
 * Scrapes the ASIN list from an individual campaign detail page/modal.
 * Amazon renders the ASIN table inside the campaign after clicking "View Details".
 */
async function scrapeCampaignAsins(page) {
    const asins = new Set();

    // Wait for ASIN table or list to appear.
    // Amazon's Creator Connections shows products in a table or grid.
    const selectors = [
        '[data-asin]',
        'td[data-asin]',
        'div[data-asin]',
        '.asin',
        // Generic: any element whose text looks like an ASIN
        'td, span, div',
    ];

    // Collect from data-asin attributes.
    const asinElements = await page.$$('[data-asin]');
    for (const el of asinElements) {
        const asin = await el.getAttribute('data-asin');
        if (asin && /^B[0-9A-Z]{9}$|^[0-9]{10}$/.test(asin.trim())) {
            asins.add(asin.trim());
        }
    }

    // Also scan the full page text for ASIN patterns as a fallback.
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const asin of extractAsins(bodyText)) {
        asins.add(asin);
    }

    return [...asins];
}

/**
 * Scrolls to the bottom of the campaign list to trigger lazy-loading.
 */
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

/**
 * Clicks "Load more" / pagination buttons until all campaigns are visible.
 */
async function clickLoadMoreUntilDone(page) {
    const loadMoreSelectors = [
        'button:has-text("Load more")',
        'button:has-text("Show more")',
        'a:has-text("Next")',
        '[data-testid="load-more"]',
        '.pagination-next',
    ];

    for (let page_num = 0; page_num < 50; page_num++) {
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
 * Attempts to select category filter tabs/chips on the Creator Connections page.
 * Amazon may surface a category sidebar, dropdown, or pill-tabs.
 * Returns the number of filter interactions that succeeded.
 */
async function applyUiCategoryFilters(page, categories) {
    let matched = 0;
    for (const category of categories) {
        // Common patterns: tab buttons, checkbox labels, chip/pill buttons
        const selectors = [
            `button:has-text("${category}")`,
            `[role="tab"]:has-text("${category}")`,
            `label:has-text("${category}")`,
            `[data-testid*="category"]:has-text("${category}")`,
            `[class*="category"]:has-text("${category}")`,
            `[class*="filter"]:has-text("${category}")`,
        ];

        for (const sel of selectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
                log.info(`Clicking UI category filter: "${category}"`);
                await el.click();
                await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
                await sleep(800);
                matched++;
                break;
            }
        }
    }
    if (matched === 0 && categories.length > 0) {
        log.info('No UI category filters found — will apply keyword filtering after scraping.');
    }
    return matched;
}

/**
 * Returns true if the campaign matches at least one of the requested category keywords.
 * Checks category label, title, description, and brand name (all case-insensitive).
 */
function matchesCategories(campaign, categories) {
    if (!categories || categories.length === 0) return true;

    const haystack = [
        campaign.category,
        campaign.campaignTitle,
        campaign.description,
        campaign.brandName,
        campaign.rawCardText,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return categories.some((cat) => haystack.includes(cat.toLowerCase()));
}

/**
 * Parses campaign cards from the Creator Connections listing page.
 * Returns an array of raw campaign objects (without per-ASIN drill-down).
 */
async function parseCampaignCards(page) {
    return page.evaluate(() => {
        const campaigns = [];

        // Amazon's Creator Connections uses various component structures
        // depending on the A/B test bucket. We try multiple selectors.
        const cardSelectors = [
            '[data-testid="campaign-card"]',
            '.campaign-card',
            '[class*="CampaignCard"]',
            '[class*="campaign-card"]',
            '[class*="promotionCard"]',
            '[class*="PromotionCard"]',
            // Fallback: any article or section with a heading inside the list
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

            // Extract raw text then hunt for ASINs.
            const cardText = card.innerText ?? card.textContent ?? '';
            const asinMatches = cardText.match(/\b(B[0-9A-Z]{9}|[0-9]{10})\b/g) ?? [];
            const asins = [...new Set(asinMatches)];

            // Campaign identifiers — Amazon embeds these in data-* attributes or hrefs.
            const campaignId =
                card.dataset.campaignId ??
                card.dataset.id ??
                card.dataset.promotionId ??
                getAttr('a', 'href')?.match(/[?&]id=([^&]+)/)?.[1] ??
                null;

            const detailLink = card.querySelector('a')?.href ?? null;

            campaigns.push({
                campaignId,
                detailLink,
                brandName:
                    getText('[class*="brand"]') ??
                    getText('[class*="Brand"]') ??
                    getText('.brand-name') ??
                    null,
                campaignTitle:
                    getText('h2') ??
                    getText('h3') ??
                    getText('[class*="title"]') ??
                    getText('[class*="Title"]') ??
                    null,
                commissionRate:
                    getText('[class*="commission"]') ??
                    getText('[class*="Commission"]') ??
                    getText('[class*="rate"]') ??
                    null,
                startDate:
                    getText('[class*="startDate"]') ??
                    getText('[class*="start-date"]') ??
                    null,
                endDate:
                    getText('[class*="endDate"]') ??
                    getText('[class*="end-date"]') ??
                    null,
                description:
                    getText('[class*="description"]') ??
                    getText('[class*="Description"]') ??
                    null,
                category:
                    getText('[class*="category"]') ??
                    getText('[class*="Category"]') ??
                    getText('[data-testid*="category"]') ??
                    getText('[class*="tag"]') ??
                    getText('[class*="Tag"]') ??
                    null,
                asinsFromCard: asins,
                rawCardText: cardText.substring(0, 500),
            });
        }

        return campaigns;
    });
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
    maxCampaigns = 0,
    scrapeAsinDetails = true,
    categories = [],
    proxyConfiguration: proxyConfig,
    sessionCookies = [],
} = input;

// Normalise categories: trim whitespace, drop empty strings.
const categoryFilter = categories.map((c) => c.trim()).filter(Boolean);

// Validate required credentials (unless cookies supplied).
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
    // Stealth: mask automation signals.
    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                // Hide WebDriver flag.
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                // Spoof plugin count.
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            });
        },
    ],
    async requestHandler({ page, request }) {
        const label = request.label;

        if (label === 'LOGIN') {
            // ------------------------------------------------------------------
            // Step 1: Authenticate
            // ------------------------------------------------------------------
            if (sessionCookies.length > 0) {
                log.info(`Injecting ${sessionCookies.length} session cookies…`);
                await page.context().addCookies(sessionCookies);
                await page.goto(CREATOR_CONNECTIONS_URL, { waitUntil: 'domcontentloaded' });
            } else {
                await loginToAmazonAssociates(page, { email, password, otpSecret });
                await page.goto(CREATOR_CONNECTIONS_URL, { waitUntil: 'domcontentloaded' });
            }

            // Wait for the Creator Connections page to render its campaigns.
            log.info('Waiting for Creator Connections page to load…');
            await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
            await sleep(2000);

            // ------------------------------------------------------------------
            // Step 2: Apply UI category filters (if the page has filter controls).
            // ------------------------------------------------------------------
            if (categoryFilter.length > 0) {
                log.info(`Applying category filters: ${categoryFilter.join(', ')}`);
                await applyUiCategoryFilters(page, categoryFilter);
            }

            // ------------------------------------------------------------------
            // Step 3: Scroll / paginate to reveal all campaigns.
            // ------------------------------------------------------------------
            log.info('Loading all campaigns…');
            await scrollToLoadAllCampaigns(page);
            await clickLoadMoreUntilDone(page);

            // ------------------------------------------------------------------
            // Step 4: Parse campaign cards from the listing page.
            // ------------------------------------------------------------------
            log.info('Parsing campaign cards…');
            const allCampaigns = await parseCampaignCards(page);
            log.info(`Found ${allCampaigns.length} campaign card(s) on the listing page.`);

            // ------------------------------------------------------------------
            // Step 5: Keyword-based category filter (catches what the UI missed).
            // ------------------------------------------------------------------
            const campaigns = categoryFilter.length > 0
                ? allCampaigns.filter((c) => matchesCategories(c, categoryFilter))
                : allCampaigns;

            if (categoryFilter.length > 0) {
                log.info(
                    `Category filter "${categoryFilter.join(', ')}" matched ${campaigns.length}/${allCampaigns.length} campaign(s).`,
                );
            }

            if (campaigns.length === 0) {
                // If the standard card parsing found nothing, save a debug snapshot.
                log.warning(
                    'No campaigns found with standard selectors. Saving a page snapshot for debugging.',
                );
                const html = await page.content();
                await Actor.setValue('debug_page_html', html, { contentType: 'text/html' });
                const screenshot = await page.screenshot({ fullPage: true });
                await Actor.setValue('debug_screenshot', screenshot, { contentType: 'image/png' });
                return;
            }

            // Respect the maxCampaigns cap.
            const limit = maxCampaigns > 0 ? maxCampaigns : campaigns.length;
            const toProcess = campaigns.slice(0, limit);

            if (!scrapeAsinDetails) {
                // Fast path: save what we already have from the cards.
                for (const campaign of toProcess) {
                    await dataset.pushData({
                        ...campaign,
                        category: campaign.category ?? null,
                        asins: campaign.asinsFromCard,
                        asinCount: campaign.asinsFromCard.length,
                        scrapedAt: new Date().toISOString(),
                    });
                }
                log.info(`Saved ${toProcess.length} campaigns (card-level data only).`);
                return;
            }

            // ------------------------------------------------------------------
            // Step 4 (optional): Drill into each campaign for full ASIN list.
            // ------------------------------------------------------------------
            for (const [i, campaign] of toProcess.entries()) {
                log.info(`Processing campaign ${i + 1}/${toProcess.length}: "${campaign.campaignTitle}"`);

                let asins = campaign.asinsFromCard;

                if (campaign.detailLink) {
                    try {
                        await page.goto(campaign.detailLink, { waitUntil: 'domcontentloaded' });
                        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
                        await sleep(1500);

                        // Try to reveal the full ASIN list — some campaigns hide it behind
                        // a "View all products" expander.
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

                        asins = await scrapeCampaignAsins(page);
                        log.info(`  → Found ${asins.length} ASIN(s) on detail page.`);
                    } catch (err) {
                        log.warning(`  → Could not load detail page (${err.message}). Using card-level ASINs.`);
                    }
                }

                // Merge any ASINs found on the card with those from the detail page.
                const allAsins = [...new Set([...campaign.asinsFromCard, ...asins])];

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
                    asins: allAsins,
                    asinCount: allAsins.length,
                    scrapedAt: new Date().toISOString(),
                });

                // Polite delay between detail-page requests.
                await sleep(800 + Math.random() * 700);
            }

            log.info(`Done. Saved ${toProcess.length} campaigns to the dataset.`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    },
});

await crawler.run([
    {
        url: CREATOR_CONNECTIONS_URL,
        label: 'LOGIN',
        // Treat this as a unique entry point — no deduplication needed.
        uniqueKey: `login-${Date.now()}`,
    },
]);

await Actor.exit();
