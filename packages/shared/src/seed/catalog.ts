import type { PageTier, SitePage } from '../types';
import { type Rng, slug, addDays } from './rng';

const BASE = 'https://deodap.in';

export const CATEGORIES: { name: string; products: string[] }[] = [
  { name: 'Kitchen Tools', products: ['Vegetable Chopper', 'Silicone Spatula Set', 'Manual Juicer', 'Garlic Press', 'Measuring Spoon Set', 'Peeler 3-in-1', 'Egg Separator', 'Dough Maker', 'Kitchen Scissors', 'Mandoline Slicer'] },
  { name: 'Kitchen Storage', products: ['Airtight Container Set', 'Spice Rack Organizer', 'Fridge Storage Box', 'Vacuum Food Container', 'Rice Dispenser', 'Glass Jar Set'] },
  { name: 'Water Bottles', products: ['Stainless Steel Water Bottle', 'Insulated Flask', 'Kids Sipper Bottle', 'Glass Water Bottle', 'Fridge Bottle Set'] },
  { name: 'Home Decor', products: ['LED Fairy Lights', 'Artificial Plant Pot', 'Wall Clock', 'Photo Frame Set', 'Decorative Diya Set', 'Table Lamp'] },
  { name: 'Cleaning Supplies', products: ['Microfiber Mop', 'Toilet Brush Set', 'Dish Scrubber', 'Lint Remover', 'Spray Mop', 'Cleaning Gloves'] },
  { name: 'Toys & Games', products: ['Building Blocks Set', 'Remote Control Car', 'Puzzle Board', 'Soft Toy Teddy', 'Rubik Cube', 'Water Gun', 'Kids Kitchen Set'] },
  { name: 'Mobile Accessories', products: ['Mobile Stand', 'Phone Ring Holder', 'Selfie Stick', 'Cable Organizer', 'Car Phone Holder'] },
  { name: 'Electronics Gadgets', products: ['Mini USB Fan', 'Rechargeable LED Torch', 'Digital Kitchen Scale', 'Electric Lighter', 'Portable Hand Blender', 'USB Night Lamp'] },
  { name: 'Bathroom Accessories', products: ['Shower Caddy', 'Soap Dispenser', 'Toothbrush Holder', 'Bath Mat', 'Towel Rack'] },
  { name: 'Personal Care', products: ['Hair Straightener Brush', 'Nail Cutter Set', 'Facial Roller', 'Massage Gun Mini', 'Shower Cap Set'] },
  { name: 'Stationery', products: ['Gel Pen Set', 'Sticky Notes Pack', 'Desk Organizer', 'Geometry Box', 'Kids Drawing Book'] },
  { name: 'Festive & Gifts', products: ['Rakhi Gift Hamper', 'Diwali Decor Lights', 'Gift Wrapping Kit', 'Puja Thali Set', 'Rangoli Stencil Set'] },
  { name: 'Bags & Travel', products: ['Travel Organizer Pouch', 'Laptop Backpack', 'Shoe Storage Bag', 'Foldable Tote Bag', 'Neck Pillow'] },
  { name: 'Garden & Outdoor', products: ['Garden Tool Set', 'Plant Watering Can', 'Hanging Planter', 'Bird Feeder', 'Solar Garden Light'] },
  { name: 'Baby Care', products: ['Baby Feeding Bottle', 'Baby Bath Tub', 'Teether Toy', 'Baby Bib Set', 'Baby Nail Trimmer'] },
];

const SUB = ['Combo', 'Premium', 'Pack of 2', 'Large', 'Mini', 'Pro', 'Classic', 'Set of 4', 'Pack of 6', 'Deluxe'];

export interface Catalog {
  pages: SitePage[];
  byUrl: Map<string, SitePage>;
  home: SitePage;
  collections: SitePage[];
  products: SitePage[];
  blogs: SitePage[];
  productCategory: Map<string, string>; // product url -> collection handle
}

/** Builds the sample site inventory and computes page-value tiers per PDF §3.1. */
export function buildCatalog(r: Rng, now: Date): Catalog {
  const pages: SitePage[] = [];
  const home: SitePage = {
    id: 'pg-home', url: `${BASE}/`, path: '/', template: 'home', title: 'DeoDap – Wholesale Shopping India | No MOQ', tier: 1,
    tierReason: 'Homepage is always Tier 1 (PDF §3.1)', revenue90d: 0, organicSessions90d: 182000, impressions28d: 640000, clicks28d: 41000,
    indexable: true, lastModified: addDays(now, -2).toISOString(), source: 'sample',
  };
  pages.push(home);

  // Collections: categories + sub-collections → 45 collections
  const collections: SitePage[] = [];
  const collectionNames: string[] = [];
  for (const c of CATEGORIES) {
    collectionNames.push(c.name);
    collectionNames.push(`${c.name} Wholesale`);
    collectionNames.push(`Best ${c.name}`);
  }
  collectionNames.forEach((n, i) => {
    const handle = slug(n);
    collections.push({
      id: `pg-col-${i}`, url: `${BASE}/collections/${handle}`, path: `/collections/${handle}`, template: 'collection', title: n,
      tier: 2, tierReason: '', revenue90d: Math.round(r.float(20000, 900000)), organicSessions90d: r.int(200, 40000),
      impressions28d: r.int(500, 120000), clicks28d: r.int(10, 5000), indexable: true, collectionHandle: handle,
      lastModified: addDays(now, -r.int(1, 260)).toISOString(), source: 'sample',
    });
  });
  // Tier: top 20 collections by revenue OR sessions rank
  rankTier(collections, 20, 'collections');
  pages.push(...collections);

  // Products: ~650
  const products: SitePage[] = [];
  const productCategory = new Map<string, string>();
  let pid = 0;
  for (const c of CATEGORIES) {
    const handle = slug(c.name);
    for (const p of c.products) {
      for (const sfx of SUB) {
        if (r.chance(0.55) || products.length < 40) {
          const name = `${p} ${sfx}`;
          const h = slug(`${name}-${pid}`);
          const imp = r.chance(0.8) ? r.int(0, 30000) : 0;
          const prod: SitePage = {
            id: `pg-prod-${pid}`, url: `${BASE}/products/${h}`, path: `/products/${h}`, template: 'product', title: name,
            tier: 3, tierReason: '', revenue90d: Math.round(Math.pow(r.next(), 3) * 450000), organicSessions90d: r.int(0, 9000),
            impressions28d: imp, clicks28d: Math.round(imp * r.float(0, 0.06)), indexable: true, collectionHandle: handle,
            lastModified: addDays(now, -r.int(0, 400)).toISOString(), source: 'sample',
          };
          products.push(prod);
          productCategory.set(prod.url, handle);
          pid++;
        }
      }
    }
  }
  rankTier(products, 200, 'products');
  pages.push(...products);

  const blogTitles = [
    'How to Start a Dropshipping Business in India', 'Best Wholesale Kitchen Products for Resellers', 'Diwali Gifting Ideas Under ₹199',
    'No MOQ Wholesale: What It Means for Small Sellers', 'Top 10 Monsoon Products to Stock', 'Rakhi Gift Hampers Buying Guide',
    'Back to School Stationery Wholesale List', 'How to Price Products for Resale', 'Wedding Season Return Gifts in Bulk',
    'Kitchen Gadgets Trending This Year', 'Guide to GST Invoices for Wholesale Buyers', 'Toys Safety Checklist for Retailers',
    'How to Choose a Water Bottle Supplier', 'Holi Party Supplies Wholesale', 'Starting a Gift Shop on a Budget',
    'Home Decor Trends for Festive Season', 'Dropshipping vs Wholesale: Pros and Cons', 'Packaging Tips for Online Sellers',
    'Best Selling Mobile Accessories to Resell', 'Cleaning Products That Sell Year-Round', 'How COD Works for Resellers',
    'Baby Care Products: What Retailers Should Know', 'Stainless Steel vs Plastic Bottles', 'Winter Essentials to Stock Early',
  ];
  const blogs: SitePage[] = blogTitles.map((t, i) => {
    const h = slug(t);
    const clicks = r.chance(0.75) ? r.int(1, 3000) : 0;
    return {
      id: `pg-blog-${i}`, url: `${BASE}/blogs/news/${h}`, path: `/blogs/news/${h}`, template: 'blog_article', title: t,
      tier: clicks > 0 ? 2 : 3, tierReason: clicks > 0 ? 'Blog post with clicks (PDF §3.1 Tier 2)' : 'Other indexable (Tier 3)',
      organicSessions90d: clicks * 3, impressions28d: clicks * 40, clicks28d: clicks, indexable: true,
      lastModified: addDays(now, -r.int(5, 500)).toISOString(), source: 'sample',
    } satisfies SitePage;
  });
  pages.push(...blogs);

  for (const [i, t] of ['About Us', 'Contact Us', 'Shipping Policy', 'Return Policy', 'Dropshipping Program', 'Bulk Order Enquiry', 'FAQ', 'Track Order'].entries()) {
    const h = slug(t);
    pages.push({
      id: `pg-page-${i}`, url: `${BASE}/pages/${h}`, path: `/pages/${h}`, template: 'page', title: t, tier: 3,
      tierReason: 'Other indexable (Tier 3)', indexable: true, impressions28d: r.int(0, 2000), clicks28d: r.int(0, 200),
      lastModified: addDays(now, -r.int(10, 600)).toISOString(), source: 'sample',
    });
  }

  const byUrl = new Map(pages.map((p) => [p.url, p]));
  return { pages, byUrl, home, collections, products, blogs, productCategory };
}

function rankTier(list: SitePage[], topN: number, label: string) {
  const byRev = [...list].sort((a, b) => (b.revenue90d ?? 0) - (a.revenue90d ?? 0)).slice(0, topN);
  const bySes = [...list].sort((a, b) => (b.organicSessions90d ?? 0) - (a.organicSessions90d ?? 0)).slice(0, topN);
  const revSet = new Set(byRev.map((p) => p.id));
  const sesSet = new Set(bySes.map((p) => p.id));
  for (const p of list) {
    let tier: PageTier;
    let reason: string;
    if (revSet.has(p.id) || sesSet.has(p.id)) {
      tier = 1;
      reason = `Top ${topN} ${label} by last-90-day ${revSet.has(p.id) ? 'revenue' : 'organic sessions'} (PDF §3.1)`;
    } else if (p.template === 'collection') {
      tier = 2;
      reason = 'Other indexable collection (PDF §3.1 Tier 2)';
    } else if ((p.impressions28d ?? 0) > 0) {
      tier = 2;
      reason = 'Product with organic impressions (PDF §3.1 Tier 2)';
    } else {
      tier = 3;
      reason = 'Other indexable (PDF §3.1 Tier 3)';
    }
    p.tier = tier;
    p.tierReason = reason;
  }
}
