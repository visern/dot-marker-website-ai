#!/usr/bin/env node
// Pulls the facts that live in index.html's book cards (title, series,
// description, pages, ages, rating, review count, purchase links) into
// knowledge/products.json, so editing the visible site and the knowledge
// base the chatbot reads from can't silently drift apart (this is exactly
// how a stale ASIN ended up live on the site once before).
//
// This is a LOCAL, MANUAL step — run it after editing index.html's book
// cards, review the diff it prints, then commit the updated
// knowledge/products.json (and any knowledge/books/*.md heading changes)
// yourself. It intentionally does not run as part of the Vercel build:
// build-time file writes never get committed back to the repo, so syncing
// there would just silently disappear on the next deploy.
//
// Only fields that index.html's book cards actually contain are synced
// (title, series, description, pages, ages, rating, review_count,
// amazon_url, etsy_url). Fields with no equivalent in the HTML
// (image_url, language, themes, available) are left untouched. The long-form
// marketing copy and "Full contents list" sections in knowledge/books/*.md
// have no source of truth in index.html (the card's book-desc is one
// sentence, not the full listing copy) — update those by hand from the real
// Amazon/Etsy listing, same as before this script existed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const PRODUCTS_PATH = path.join(ROOT, 'knowledge', 'products.json');
const BOOKS_DIR = path.join(ROOT, 'knowledge', 'books');

function extractAsin(amazonUrl) {
  const match = amazonUrl && amazonUrl.match(/\/dp\/([A-Z0-9]+)/);
  return match ? match[1] : null;
}

function parseBookCards(html) {
  const cards = [];
  const cardRegex = /<article class="book-card[^"]*">([\s\S]*?)<\/article>/g;
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html))) {
    const block = cardMatch[1];

    const series = (block.match(/<div class="book-series[^"]*">([^<]+)<\/div>/) || [])[1];
    const title = (block.match(/<h3 class="book-title">([^<]+)<\/h3>/) || [])[1];
    const desc = (block.match(/<p class="book-desc">([^<]+)<\/p>/) || [])[1];

    const ratingBlock = (block.match(/<div class="book-rating">([\s\S]*?)<\/div>/) || [])[1] || '';
    const ratingMatch = ratingBlock.match(/(\d+(?:\.\d+)?)\s*·\s*(\d+)\s*reviews?/);
    const rating = ratingMatch ? Number(ratingMatch[1]) : null;
    const reviewCount = ratingMatch ? Number(ratingMatch[2]) : 0;

    const metaBlock = (block.match(/<div class="book-meta">([\s\S]*?)<\/div>/) || [])[1] || '';
    const pagesMatch = metaBlock.match(/(\d+)\s*pages/);
    const pages = pagesMatch ? Number(pagesMatch[1]) : null;
    const agesMatch = metaBlock.match(/Ages\s+(\d+)(?:[–-](\d+))?\+?/);
    const minimumAge = agesMatch ? Number(agesMatch[1]) : null;
    const maximumAge = agesMatch && agesMatch[2] ? Number(agesMatch[2]) : null;

    const amazonUrl = (block.match(/<a href="(https:\/\/www\.amazon\.com[^"]+)"[^>]*>Buy on Amazon/) || [])[1] || null;
    const etsyUrl = (block.match(/<a href="(https:\/\/www\.etsy\.com[^"]+)"[^>]*>Buy on Etsy/) || [])[1] || null;

    if (!title || !amazonUrl) continue; // not a real book card, skip
    cards.push({ title, series, desc, rating, reviewCount, pages, minimumAge, maximumAge, amazonUrl, etsyUrl });
  }
  return cards;
}

// Matches the hand-formatted style of knowledge/products.json (2-space
// indent, arrays of primitives kept on one line) — JSON.stringify(products,
// null, 2) would explode every "themes" array onto multiple lines and turn
// every sync run into a noisy, unrelated formatting diff.
function stringifyProducts(products) {
  const productBlocks = products.map((product) => {
    const fieldLines = Object.keys(product).map((key) => {
      const value = product[key];
      const valueStr = Array.isArray(value)
        ? `[${value.map((v) => JSON.stringify(v)).join(', ')}]`
        : JSON.stringify(value);
      return `    "${key}": ${valueStr}`;
    });
    return `  {\n${fieldLines.join(',\n')}\n  }`;
  });
  return `[\n${productBlocks.join(',\n')}\n]\n`;
}

function updateBookHeading(productId, newTitle) {
  const filePath = path.join(BOOKS_DIR, `${productId}.md`);
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  if (!lines[0].startsWith('# ')) return false;
  if (lines[0] === `# ${newTitle}`) return false;
  lines[0] = `# ${newTitle}`;
  fs.writeFileSync(filePath, lines.join('\n'));
  return true;
}

function main() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  const cards = parseBookCards(html);

  const cardsByAsin = new Map();
  for (const card of cards) {
    const asin = extractAsin(card.amazonUrl);
    if (asin) cardsByAsin.set(asin, card);
  }

  let changedCount = 0;
  const FIELD_MAP = [
    ['title', 'title'],
    ['series', 'series'],
    ['description', 'desc'],
    ['minimum_age', 'minimumAge'],
    ['maximum_age', 'maximumAge'],
    ['pages', 'pages'],
    ['amazon_url', 'amazonUrl'],
    ['etsy_url', 'etsyUrl'],
    ['rating', 'rating'],
    ['review_count', 'reviewCount'],
  ];

  for (const product of products) {
    const asin = extractAsin(product.amazon_url);
    const card = asin ? cardsByAsin.get(asin) : null;
    if (!card) {
      console.log(`No matching book card found in index.html for "${product.title}" (${product.id}) — left untouched.`);
      continue;
    }

    const changes = [];
    for (const [productField, cardField] of FIELD_MAP) {
      const oldValue = product[productField];
      const newValue = card[cardField];
      if (newValue === undefined) continue;
      if (newValue === null && oldValue === null) continue;
      if (oldValue !== newValue) {
        changes.push(`  ${productField}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`);
        product[productField] = newValue;
      }
    }

    if (changes.length) {
      console.log(`Updated "${product.id}":`);
      changes.forEach((line) => console.log(line));
      changedCount++;
    }

    if (updateBookHeading(product.id, product.title)) {
      console.log(`  Updated heading in knowledge/books/${product.id}.md to match new title.`);
    }
  }

  const matchedAsins = new Set(products.map((p) => extractAsin(p.amazon_url)).filter(Boolean));
  for (const card of cards) {
    const asin = extractAsin(card.amazonUrl);
    if (asin && !matchedAsins.has(asin)) {
      console.log(`\nNo product entry found for book card "${card.title}" (ASIN ${asin}).`);
      console.log('Add a new entry to knowledge/products.json and a knowledge/books/<id>.md file by hand.');
    }
  }

  if (changedCount === 0) {
    console.log('knowledge/products.json is already in sync with index.html.');
    return;
  }

  fs.writeFileSync(PRODUCTS_PATH, stringifyProducts(products));
  console.log(`\nWrote ${changedCount} updated product(s) to knowledge/products.json. Review the diff and commit.`);
}

main();
