import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { searchParamsSchema } from "@shared/schema";
import type {
  HouseHackListing, ScoreBreakdown, MarketStats, SearchResult,
  SearchParams, UnitInfo, SchoolInfo, PriceReduction, ParkingType,
  LoanType, RentControlStatus, NegotiationSignal, NegotiationStrength,
} from "@shared/schema";

// In-memory API key storage
let storedRealtyKey: string | null = null;
let storedRentcastKey: string | null = null;

// --- SEEDED PRNG ---
function createSeededRng(seed: number) {
  let s = seed | 0;
  return function (): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// --- HELPERS ---
function fmtUSD(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

// --- LOAN CONFIGURATION ---

interface LoanConfig {
  downPaymentPct: number;
  fundingFeePct: number;
  rate: number;
  closingCostPct: number;
  pmiMonthlyPct: number; // Monthly PMI as % of loan (FHA MIP)
}

function getLoanConfig(loanType: LoanType): LoanConfig {
  switch (loanType) {
    case "va_first":
      return { downPaymentPct: 0, fundingFeePct: 0.0215, rate: 0.0625, closingCostPct: 0.02, pmiMonthlyPct: 0 };
    case "va_subsequent":
      return { downPaymentPct: 0, fundingFeePct: 0.033, rate: 0.0625, closingCostPct: 0.02, pmiMonthlyPct: 0 };
    case "va_disabled":
      return { downPaymentPct: 0, fundingFeePct: 0, rate: 0.0625, closingCostPct: 0.02, pmiMonthlyPct: 0 };
    case "fha":
    default:
      return { downPaymentPct: 0.035, fundingFeePct: 0, rate: 0.065, closingCostPct: 0.03, pmiMonthlyPct: 0.00071 };
  }
}

// --- FINANCIAL HELPERS ---

function calculatePITI(price: number, loanType: LoanType = "fha"): number {
  const config = getLoanConfig(loanType);
  const downPayment = price * config.downPaymentPct;
  // VA funding fee is rolled into loan amount
  const fundingFee = (price - downPayment) * config.fundingFeePct;
  const loanAmount = price - downPayment + fundingFee;

  const monthlyRate = config.rate / 12;
  const numPayments = 360;
  const principalInterest =
    (loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments))) /
    (Math.pow(1 + monthlyRate, numPayments) - 1);
  const monthlyTax = (price * 0.012) / 12;
  const monthlyInsurance = (price * 0.005) / 12;
  // FHA has monthly MIP; VA has none
  const monthlyPMI = loanAmount * config.pmiMonthlyPct;
  return Math.round(principalInterest + monthlyTax + monthlyInsurance + monthlyPMI);
}

function getTotalCashInvested(price: number, loanType: LoanType): number {
  const config = getLoanConfig(loanType);
  const downPayment = price * config.downPaymentPct;
  const closingCosts = price * config.closingCostPct;
  // For VA, funding fee is typically rolled into loan, not out of pocket
  return Math.round(downPayment + closingCosts);
}

// --- RENT CONTROL DATABASE ---

interface RentControlInfo {
  status: RentControlStatus;
  maxIncrease: number | null;      // Annual % cap
  ownerOccupiedDuplexExempt: boolean;
  notes: string;
}

// Deterministic rent control lookup by state (and select cities)
function getRentControlInfo(state: string, city: string, unitCount: number): RentControlInfo {
  const st = state.toUpperCase().trim();
  const ct = city.toLowerCase().trim();

  // --- STATEWIDE RENT CONTROL STATES ---
  if (st === "CA") {
    // AB 1482: 5% + CPI (capped at 10%). Owner-occupied duplexes exempt.
    // Local ordinances in SF, LA, Oakland, Berkeley, etc. may be stricter
    const localControlCities = ["san francisco", "los angeles", "oakland", "berkeley", "santa monica", "west hollywood", "east palo alto", "hayward", "richmond", "mountain view", "san jose"];
    if (localControlCities.some(c => ct.includes(c))) {
      return {
        status: unitCount <= 2 ? "exempt_owner_occupied" : "local_control",
        maxIncrease: unitCount <= 2 ? null : 6.3, // AB 1482 current rate
        ownerOccupiedDuplexExempt: true,
        notes: unitCount <= 2
          ? `CA AB 1482: Owner-occupied duplex EXEMPT from rent cap. ${city} has local rent control for larger buildings.`
          : `${city} local rent control applies. AB 1482 statewide cap: 5% + CPI (currently ~6.3%). Just cause eviction after 12 months.`,
      };
    }
    return {
      status: unitCount <= 2 ? "exempt_owner_occupied" : "state_cap",
      maxIncrease: unitCount <= 2 ? null : 6.3,
      ownerOccupiedDuplexExempt: true,
      notes: unitCount <= 2
        ? "CA AB 1482: Owner-occupied duplex EXEMPT from rent cap and just cause eviction."
        : "CA AB 1482: Rent cap 5% + CPI (currently ~6.3%/yr). Just cause eviction after 12 months. Units built <15 yrs ago exempt.",
    };
  }

  if (st === "OR") {
    // Oregon: 7% + CPI (capped at 10%). 2026 cap is 9.5%. New construction (<15 yr) exempt.
    return {
      status: "state_cap",
      maxIncrease: 9.5,
      ownerOccupiedDuplexExempt: false,
      notes: "OR statewide rent cap: 7% + CPI (9.5% for 2026). New construction (<15 yr) exempt. One increase per year. No local control allowed.",
    };
  }

  if (st === "WA") {
    // Washington: 7% + CPI or 10%, whichever is lower. Effective May 2025.
    return {
      status: "state_cap",
      maxIncrease: 10,
      ownerOccupiedDuplexExempt: false,
      notes: "WA statewide rent cap: 7% + CPI or 10% (whichever lower). 90-day notice required. Effective May 2025.",
    };
  }

  // --- STATES WITH LOCAL RENT CONTROL (no statewide cap) ---
  if (st === "NY") {
    const nycAreas = ["new york", "manhattan", "brooklyn", "queens", "bronx", "staten island"];
    if (nycAreas.some(c => ct.includes(c))) {
      return {
        status: "local_control",
        maxIncrease: 3.0, // RGB 2025-26: 3% one-year, 4.5% two-year
        ownerOccupiedDuplexExempt: false,
        notes: "NYC rent stabilization: 3% (1yr) / 4.5% (2yr) for 2025-26. Applies to buildings with 6+ units built before 1974. Good Cause Eviction statewide.",
      };
    }
    return {
      status: "state_cap",
      maxIncrease: 10,
      ownerOccupiedDuplexExempt: false,
      notes: "NY Good Cause Eviction: Rent increase cap of CPI + 5% (max 10%). Exemptions for owner-occupied 1-2 units and buildings <30 yrs old.",
    };
  }

  if (st === "NJ") {
    // NJ: No statewide cap, but many cities have local rent control
    const rentControlCities = ["jersey city", "newark", "hoboken", "trenton", "elizabeth", "east orange", "paterson"];
    if (rentControlCities.some(c => ct.includes(c))) {
      return {
        status: "local_control",
        maxIncrease: 5.0,
        ownerOccupiedDuplexExempt: false,
        notes: `${city} has local rent control. NJ Anti-Eviction Act requires just cause. Check local ordinance for specific cap.`,
      };
    }
    return {
      status: "none",
      maxIncrease: null,
      ownerOccupiedDuplexExempt: false,
      notes: "NJ: No statewide rent cap. Anti-Eviction Act requires just cause for eviction. Some cities have local rent control.",
    };
  }

  if (st === "MD") {
    const controlCities = ["takoma park", "college park", "mount rainier"];
    if (controlCities.some(c => ct.includes(c))) {
      return {
        status: "local_control",
        maxIncrease: 5.0,
        ownerOccupiedDuplexExempt: false,
        notes: `${city} has local rent stabilization. Check local ordinance for specifics.`,
      };
    }
    return { status: "none", maxIncrease: null, ownerOccupiedDuplexExempt: false, notes: "MD: No statewide rent cap. Some localities have rent stabilization." };
  }

  if (st === "MN") {
    if (ct.includes("st. paul") || ct.includes("saint paul")) {
      return {
        status: "local_control",
        maxIncrease: 3.0,
        ownerOccupiedDuplexExempt: false,
        notes: "St. Paul: 3% annual rent increase cap. Voter-approved 2021. Applies to most residential rental properties.",
      };
    }
    return { status: "none", maxIncrease: null, ownerOccupiedDuplexExempt: false, notes: "MN: No statewide rent control. St. Paul has 3% local cap." };
  }

  if (st === "ME") {
    if (ct.includes("portland")) {
      return {
        status: "local_control",
        maxIncrease: 10.0,
        ownerOccupiedDuplexExempt: true,
        notes: "Portland ME: Rent cap of CPI or 10% (whichever lower). Owner-occupied 1-4 units may be exempt.",
      };
    }
    return { status: "none", maxIncrease: null, ownerOccupiedDuplexExempt: false, notes: "ME: No statewide rent cap. Portland has local rent control." };
  }

  if (st === "DC") {
    return {
      status: "local_control",
      maxIncrease: 8.9,
      ownerOccupiedDuplexExempt: false,
      notes: "DC: Rent stabilization covers most units. Annual increase: CPI + 2% (standard) or CPI + 5% (elderly/disabled). Vacancy decontrol available.",
    };
  }

  if (st === "MA") {
    if (ct.includes("boston")) {
      return {
        status: "none",
        maxIncrease: null,
        ownerOccupiedDuplexExempt: false,
        notes: "MA: Statewide rent control banned in 1994. Boston has no rent cap. Strong tenant eviction protections remain.",
      };
    }
    return { status: "none", maxIncrease: null, ownerOccupiedDuplexExempt: false, notes: "MA: Statewide rent control banned since 1994. Strong tenant protections." };
  }

  if (st === "IL") {
    if (ct.includes("chicago")) {
      return {
        status: "none",
        maxIncrease: null,
        ownerOccupiedDuplexExempt: false,
        notes: "IL: Rent control preempted statewide (1997). Chicago has no rent cap. RLTO provides tenant protections on security deposits and notice.",
      };
    }
    return { status: "none", maxIncrease: null, ownerOccupiedDuplexExempt: false, notes: "IL: Rent control preempted statewide since 1997. No local rent caps allowed." };
  }

  // --- STATES WITH PREEMPTION (no rent control possible) ---
  const preemptionStates = [
    "AL", "AZ", "AR", "CO", "FL", "GA", "ID", "IN", "IA", "KS", "KY", "LA",
    "MI", "MS", "MO", "NE", "NV", "NM", "NC", "ND", "OH", "OK", "PA", "SC",
    "SD", "TN", "TX", "UT", "VA", "WV", "WI", "WY",
  ];

  if (preemptionStates.includes(st)) {
    return {
      status: "none",
      maxIncrease: null,
      ownerOccupiedDuplexExempt: false,
      notes: `${st}: Rent control preempted statewide. No local or state rent caps. Landlord-friendly.`,
    };
  }

  // Default: unknown state
  return {
    status: "none",
    maxIncrease: null,
    ownerOccupiedDuplexExempt: false,
    notes: `${st}: No known statewide rent control. Check local ordinances.`,
  };
}

// --- SCORING ENGINE (100 pts) ---

function calculateDealScore(
  listing: Omit<HouseHackListing, "dealScore" | "scoreBreakdown" | "scoreLabel">,
  stats: MarketStats
): { dealScore: number; scoreBreakdown: ScoreBreakdown; scoreLabel: HouseHackListing["scoreLabel"] } {
  const bd: ScoreBreakdown = {
    mortgageOffsetScore: 0,
    ownerCostScore: 0,
    cashOnCashScore: 0,
    buildingAgeScore: 0,
    schoolQualityScore: 0,
    floodRiskScore: 0,
    parkingScore: 0,
    yardSpaceScore: 0,
    unitConfigScore: 0,
    lotSizeScore: 0,
    priceReductionBonus: 0,
  };

  // 1. Mortgage Offset (0-20)
  if (listing.mortgageOffsetPercent !== null) {
    const pct = listing.mortgageOffsetPercent;
    if (pct >= 100) bd.mortgageOffsetScore = 20;
    else if (pct >= 90) bd.mortgageOffsetScore = 18;
    else if (pct >= 75) bd.mortgageOffsetScore = 15;
    else if (pct >= 60) bd.mortgageOffsetScore = 12;
    else if (pct >= 45) bd.mortgageOffsetScore = 9;
    else if (pct >= 30) bd.mortgageOffsetScore = 6;
    else bd.mortgageOffsetScore = 3;
  } else {
    bd.mortgageOffsetScore = 8;
  }

  // 2. Owner Net Monthly Cost (0-15) — lower is better
  if (listing.ownerNetMonthlyCost !== null) {
    const cost = listing.ownerNetMonthlyCost;
    if (cost <= 0) bd.ownerCostScore = 15; // FREE living or positive cash flow
    else if (cost <= 500) bd.ownerCostScore = 13;
    else if (cost <= 1000) bd.ownerCostScore = 10;
    else if (cost <= 1500) bd.ownerCostScore = 7;
    else if (cost <= 2000) bd.ownerCostScore = 4;
    else bd.ownerCostScore = 2;
  } else {
    bd.ownerCostScore = 7;
  }

  // 3. Cash-on-Cash Return (0-10)
  if (listing.cashOnCashReturn !== null) {
    const coc = listing.cashOnCashReturn;
    if (coc >= 12) bd.cashOnCashScore = 10;
    else if (coc >= 8) bd.cashOnCashScore = 8;
    else if (coc >= 5) bd.cashOnCashScore = 6;
    else if (coc >= 2) bd.cashOnCashScore = 4;
    else if (coc >= 0) bd.cashOnCashScore = 2;
    else bd.cashOnCashScore = 1;
  } else {
    bd.cashOnCashScore = 4;
  }

  // 4. Building Age (0-10)
  if (listing.yearBuilt) {
    const age = new Date().getFullYear() - listing.yearBuilt;
    if (age <= 10) bd.buildingAgeScore = 10;
    else if (age <= 20) bd.buildingAgeScore = 8;
    else if (age <= 30) bd.buildingAgeScore = 6;
    else if (age <= 50) bd.buildingAgeScore = 4;
    else if (age <= 70) bd.buildingAgeScore = 2;
    else bd.buildingAgeScore = 1;
  } else {
    bd.buildingAgeScore = 4;
  }

  // 5. School Quality (0-8)
  if (listing.avgSchoolRating !== null) {
    if (listing.avgSchoolRating >= 9) bd.schoolQualityScore = 8;
    else if (listing.avgSchoolRating >= 7) bd.schoolQualityScore = 6;
    else if (listing.avgSchoolRating >= 5) bd.schoolQualityScore = 4;
    else if (listing.avgSchoolRating >= 3) bd.schoolQualityScore = 2;
    else bd.schoolQualityScore = 1;
  } else {
    bd.schoolQualityScore = 4;
  }

  // 6. Flood Risk (0-4)
  if (listing.floodFactorScore !== null) {
    if (listing.floodFactorScore <= 1) bd.floodRiskScore = 4;
    else if (listing.floodFactorScore <= 3) bd.floodRiskScore = 3;
    else if (listing.floodFactorScore <= 5) bd.floodRiskScore = 2;
    else bd.floodRiskScore = 1;
  } else {
    bd.floodRiskScore = 2;
  }

  // 7. Parking (0-8)
  const parkingScores: Record<ParkingType, number> = {
    attached_garage: 8,
    detached_garage: 6,
    driveway: 4,
    street_only: 1,
    unknown: 3,
  };
  bd.parkingScore = parkingScores[listing.parkingType];

  // 8. Yard Space (0-5)
  bd.yardSpaceScore = Math.min(5, listing.yardScore + (listing.hasFencedYard ? 1 : 0));

  // 9. Unit Configuration (0-10)
  // More units = better, uneven splits = better
  const unitCountBonus = listing.unitCount === 4 ? 5 : listing.unitCount === 3 ? 3 : 1;
  const ownerUnit = listing.units.find(u => u.isOwnerUnit);
  const rentedUnits = listing.units.filter(u => !u.isOwnerUnit);
  let unevenBonus = 0;
  if (ownerUnit && rentedUnits.length > 0) {
    const avgRentedBeds = rentedUnits.reduce((s, u) => s + u.bedrooms, 0) / rentedUnits.length;
    if (ownerUnit.bedrooms < avgRentedBeds) unevenBonus = 3; // Owner in smaller = good
    else if (ownerUnit.bedrooms === avgRentedBeds) unevenBonus = 1;
    // Owner in bigger = 0 bonus
  }
  bd.unitConfigScore = Math.min(10, unitCountBonus + unevenBonus + (listing.unitCount >= 3 ? 2 : 0));

  // 10. Lot Size (0-5)
  if (listing.lotSizeSqft) {
    if (listing.lotSizeSqft >= 10000) bd.lotSizeScore = 5;
    else if (listing.lotSizeSqft >= 7000) bd.lotSizeScore = 4;
    else if (listing.lotSizeSqft >= 5000) bd.lotSizeScore = 3;
    else if (listing.lotSizeSqft >= 3000) bd.lotSizeScore = 2;
    else bd.lotSizeScore = 1;
  } else {
    bd.lotSizeScore = 2;
  }

  // 11. Price Reduction Bonus (0-5)
  if (listing.totalReductionPercent !== null && listing.totalReductionPercent > 0) {
    if (listing.totalReductionPercent >= 10) bd.priceReductionBonus = 5;
    else if (listing.totalReductionPercent >= 5) bd.priceReductionBonus = 3;
    else if (listing.totalReductionPercent >= 2) bd.priceReductionBonus = 2;
    else bd.priceReductionBonus = 1;
  }

  const dealScore =
    bd.mortgageOffsetScore + bd.ownerCostScore + bd.cashOnCashScore +
    bd.buildingAgeScore + bd.schoolQualityScore + bd.floodRiskScore +
    bd.parkingScore + bd.yardSpaceScore + bd.unitConfigScore +
    bd.lotSizeScore + bd.priceReductionBonus;

  let scoreLabel: HouseHackListing["scoreLabel"];
  if (dealScore >= 80) scoreLabel = "Excellent Hack";
  else if (dealScore >= 65) scoreLabel = "Strong Hack";
  else if (dealScore >= 50) scoreLabel = "Decent Hack";
  else if (dealScore >= 35) scoreLabel = "Weak Hack";
  else scoreLabel = "Pass";

  return { dealScore, scoreBreakdown: bd, scoreLabel };
}

// --- RENTCAST API ---

async function fetchRentEstimate(
  apiKey: string,
  address: string,
  bedrooms: number,
  bathrooms: number,
  propertyType: string = "Multi-Family"
): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      address,
      propertyType,
      bedrooms: String(bedrooms),
      bathrooms: String(bathrooms),
    });
    const res = await fetch(`https://api.rentcast.io/v1/avm/rent/long-term?${params}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.rent || data.rentRangeLow || null;
  } catch {
    return null;
  }
}

// --- REALTY IN US API ---

interface RawMultiFamilyListing {
  id: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  price: number;
  totalBedrooms: number;
  totalBathrooms: number;
  totalSqft: number | null;
  lotSizeSqft: number | null;
  unitCount: number;
  yearBuilt: number | null;
  daysOnMarket: number | null;
  listingUrl: string | null;
  photoUrl: string | null;
  source: string;
  // Detail fields
  avgSchoolRating: number | null;
  schools: SchoolInfo[];
  floodFactorScore: number | null;
  femaZone: string | null;
  estimatedValue: number | null;
  priceReductions: PriceReduction[];
  originalListPrice: number | null;
  // Physical features from detail
  parkingType: ParkingType;
  garageSpaces: number | null;
  hasPrivateYard: boolean;
  hasFrontYard: boolean;
  hasSideYard: boolean;
  hasFencedYard: boolean;
  descriptionText: string | null;
}

async function fetchPropertyDetail(
  apiKey: string,
  propertyId: string
): Promise<Partial<RawMultiFamilyListing>> {
  const empty: Partial<RawMultiFamilyListing> = {};
  try {
    const res = await fetch(
      `https://realty-in-us.p.rapidapi.com/properties/v3/detail?property_id=${propertyId}`,
      {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": "realty-in-us.p.rapidapi.com",
        },
      }
    );
    if (!res.ok) return empty;
    const data = await res.json();
    const home = data?.data?.home;
    if (!home) return empty;

    // Schools
    const nearbySchools = home.nearby_schools?.schools || [];
    const schools: SchoolInfo[] = [];
    const ratedScores: number[] = [];
    for (const s of nearbySchools) {
      if (s.rating && s.name) {
        const levels = s.education_levels || [];
        const level = levels.includes("high") ? "high"
          : levels.includes("middle") ? "middle"
          : levels.includes("elementary") ? "elementary"
          : levels[0] || "unknown";
        schools.push({ name: s.name, rating: s.rating, level, distanceMiles: s.distance_in_miles || 0 });
        if (s.assigned === true || s.assigned === null) ratedScores.push(s.rating);
      }
    }
    const avgSchoolRating = ratedScores.length > 0
      ? Math.round((ratedScores.reduce((a, b) => a + b, 0) / ratedScores.length) * 10) / 10
      : null;

    // Flood
    const floodFactorScore = home.local?.flood?.flood_factor_score ?? null;
    const femaZones = home.local?.flood?.fema_zone;
    const femaZone = Array.isArray(femaZones) ? femaZones[0] || null : femaZones || null;

    // Value estimates
    const estimates = home.estimates?.current_values || [];
    const valid = estimates.filter((e: any) => e.estimate && e.estimate > 0);
    const estimatedValue = valid.length > 0
      ? Math.round(valid.reduce((s: number, e: any) => s + e.estimate, 0) / valid.length)
      : null;

    // Year built
    const yearBuilt = home.description?.year_built ?? null;

    // Lot size
    const lotSizeSqft = home.description?.lot_sqft ?? null;

    // Unit count
    const unitCount = home.description?.units ?? null;

    // Price history
    const history = home.property_history || [];
    const priceReductions: PriceReduction[] = [];
    let originalListPrice: number | null = null;
    const sortedHistory = [...history]
      .filter((h: any) => h.date && h.price && h.price > 0)
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let lastListedPrice: number | null = null;
    for (const event of sortedHistory) {
      const eventName = (event.event_name || "").toLowerCase();
      const price = event.price;
      if (eventName.includes("listed") && !eventName.includes("removed")) {
        if (originalListPrice === null) originalListPrice = price;
        if (lastListedPrice !== null && price < lastListedPrice) {
          const dropAmount = lastListedPrice - price;
          priceReductions.push({
            date: event.date,
            previousPrice: lastListedPrice,
            newPrice: price,
            dropAmount,
            dropPercent: Math.round((dropAmount / lastListedPrice) * 1000) / 10,
          });
        }
        lastListedPrice = price;
      }
      if (eventName.includes("price") && eventName.includes("change")) {
        if (lastListedPrice !== null && price < lastListedPrice) {
          const dropAmount = lastListedPrice - price;
          priceReductions.push({
            date: event.date,
            previousPrice: lastListedPrice,
            newPrice: price,
            dropAmount,
            dropPercent: Math.round((dropAmount / lastListedPrice) * 1000) / 10,
          });
        }
        if (price > 0) lastListedPrice = price;
      }
    }

    // Parking & yard from description and details
    let parkingType: ParkingType = "unknown";
    let garageSpaces: number | null = null;
    let hasPrivateYard = false, hasFrontYard = false, hasSideYard = false, hasFencedYard = false;
    const descText = (home.description?.text || "").toLowerCase();
    const allDetailsText = JSON.stringify(home.details || []).toLowerCase();
    const combined = descText + " " + allDetailsText;

    if (combined.includes("attached garage") || combined.includes("att garage") || combined.includes("att gar")) {
      parkingType = "attached_garage";
    } else if (combined.includes("detached garage") || combined.includes("det garage") || combined.includes("external garage")) {
      parkingType = "detached_garage";
    } else if (combined.includes("garage")) {
      parkingType = "detached_garage";
    } else if (combined.includes("driveway") || combined.includes("off-street") || combined.includes("parking pad") || combined.includes("carport")) {
      parkingType = "driveway";
    } else if (combined.includes("street parking") || combined.includes("no garage") || combined.includes("on-street")) {
      parkingType = "street_only";
    }

    const garageMatch = combined.match(/(\d+)\s*(?:car|space|stall)?\s*garage/);
    if (garageMatch) garageSpaces = parseInt(garageMatch[1], 10);

    if (combined.includes("private yard") || combined.includes("backyard") || combined.includes("back yard")) hasPrivateYard = true;
    if (combined.includes("front yard")) hasFrontYard = true;
    if (combined.includes("side yard")) hasSideYard = true;
    if (combined.includes("fenced yard") || combined.includes("fenced-in") || combined.includes("fenced back")) hasFencedYard = true;

    return {
      yearBuilt, lotSizeSqft, unitCount: unitCount || undefined,
      avgSchoolRating, schools: schools.slice(0, 6),
      floodFactorScore, femaZone, estimatedValue,
      priceReductions, originalListPrice,
      parkingType, garageSpaces,
      hasPrivateYard, hasFrontYard, hasSideYard, hasFencedYard,
      descriptionText: home.description?.text || null,
    };
  } catch {
    return empty;
  }
}

async function enrichWithDetails(apiKey: string, listings: RawMultiFamilyListing[]): Promise<RawMultiFamilyListing[]> {
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 500;
  const enriched = [...listings];

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch = listings.slice(i, i + BATCH_SIZE);
    const details = await Promise.all(batch.map(l => fetchPropertyDetail(apiKey, l.id)));
    details.forEach((detail, j) => {
      const idx = i + j;
      enriched[idx] = { ...enriched[idx], ...detail };
    });
    if (i + BATCH_SIZE < listings.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  return enriched;
}

async function fetchFromRealtorAPI(
  apiKey: string,
  location: string,
  unitCount?: string,
  bedrooms?: string,
  bathrooms?: string,
  minPrice?: number,
  maxPrice?: number
): Promise<RawMultiFamilyListing[]> {
  // Auto-complete location
  const acRes = await fetch(
    `https://realty-in-us.p.rapidapi.com/locations/v2/auto-complete?input=${encodeURIComponent(location)}&limit=1`,
    { headers: { "x-rapidapi-key": apiKey, "x-rapidapi-host": "realty-in-us.p.rapidapi.com" } }
  );
  if (!acRes.ok) throw new Error(`Location lookup failed (${acRes.status})`);
  const acData = await acRes.json();
  const autocomplete = acData.autocomplete || [];
  if (autocomplete.length === 0) throw new Error(`No location found for "${location}".`);

  const filters: any = {
    status: ["for_sale"],
    type: ["multi_family"],
  };

  if (bedrooms && bedrooms !== "any") {
    const bedsNum = parseInt(bedrooms, 10);
    if (!isNaN(bedsNum)) filters.beds = { min: bedsNum };
  }
  if (bathrooms && bathrooms !== "any") {
    const bathsNum = parseInt(bathrooms, 10);
    if (!isNaN(bathsNum)) filters.baths = { min: bathsNum };
  }
  if (minPrice || maxPrice) {
    filters.list_price = {};
    if (minPrice) filters.list_price.min = minPrice;
    if (maxPrice) filters.list_price.max = maxPrice;
  }

  const firstResult = autocomplete[0];
  let searchBody: any = { limit: 20, offset: 0, ...filters };

  if (firstResult.area_type === "postal_code") {
    searchBody.postal_code = firstResult.mpr_id || location;
  } else if (firstResult.area_type === "city") {
    searchBody.city = firstResult.city;
    searchBody.state_code = firstResult.state_code;
  } else {
    if (firstResult.city && firstResult.state_code) {
      searchBody.city = firstResult.city;
      searchBody.state_code = firstResult.state_code;
    } else {
      searchBody.postal_code = location;
    }
  }

  const searchRes = await fetch("https://realty-in-us.p.rapidapi.com/properties/v3/list", {
    method: "POST",
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "realty-in-us.p.rapidapi.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(searchBody),
  });
  if (!searchRes.ok) throw new Error(`Search failed (${searchRes.status})`);

  const searchData = await searchRes.json();
  const results = searchData?.data?.home_search?.results || [];

  let baseListings: RawMultiFamilyListing[] = results.map((r: any) => {
    const loc = r.location || {};
    const addr = loc.address || {};
    const desc = r.description || {};

    return {
      id: r.property_id || `${addr.line}-${addr.postal_code}`,
      address: addr.line || "Address unavailable",
      city: addr.city || "",
      state: addr.state_code || addr.state || "",
      zipCode: addr.postal_code || "",
      price: r.list_price || 0,
      totalBedrooms: desc.beds || 0,
      totalBathrooms: desc.baths || 0,
      totalSqft: desc.sqft || null,
      lotSizeSqft: desc.lot_sqft || null,
      unitCount: desc.units || 2,
      yearBuilt: desc.year_built || null,
      daysOnMarket: r.list_date
        ? Math.floor((new Date(new Date().toISOString().slice(0, 10)).getTime() - new Date(r.list_date).getTime()) / (1000 * 60 * 60 * 24))
        : null,
      listingUrl: r.href ? (r.href.startsWith("http") ? r.href : `https://www.realtor.com${r.href}`) : null,
      photoUrl: r.primary_photo?.href || (r.photos?.[0]?.href) || null,
      source: "Realtor.com",
      avgSchoolRating: null, schools: [],
      floodFactorScore: null, femaZone: null, estimatedValue: null,
      priceReductions: [], originalListPrice: null,
      parkingType: "unknown" as ParkingType,
      garageSpaces: null,
      hasPrivateYard: false, hasFrontYard: false, hasSideYard: false, hasFencedYard: false,
      descriptionText: null,
    };
  });

  // Filter by unit count
  if (unitCount && unitCount !== "any") {
    const target = parseInt(unitCount, 10);
    baseListings = baseListings.filter(l => l.unitCount === target);
  }

  // Enrich with detail data
  console.log(`Enriching ${baseListings.length} multi-family listings with detail data...`);
  const enriched = await enrichWithDetails(apiKey, baseListings);
  return enriched;
}

// --- RENT ESTIMATION (PER UNIT) ---

function estimateUnitBreakdown(
  totalBeds: number,
  totalBaths: number,
  totalSqft: number | null,
  unitCount: number,
  rand: () => number
): UnitInfo[] {
  const units: UnitInfo[] = [];

  if (unitCount === 2) {
    // Try to create uneven split
    const bigBeds = Math.ceil(totalBeds * 0.6);
    const smallBeds = totalBeds - bigBeds;
    const bigBaths = Math.ceil(totalBaths * 0.6);
    const smallBaths = totalBaths - bigBaths;
    const bigSqft = totalSqft ? Math.round(totalSqft * 0.55) : null;
    const smallSqft = totalSqft ? totalSqft - bigSqft! : null;

    units.push({ unitLabel: "Unit A", bedrooms: Math.max(1, smallBeds), bathrooms: Math.max(1, smallBaths), sqft: smallSqft, estimatedRent: null, isOwnerUnit: true });
    units.push({ unitLabel: "Unit B", bedrooms: Math.max(1, bigBeds), bathrooms: Math.max(1, bigBaths), sqft: bigSqft, estimatedRent: null, isOwnerUnit: false });
  } else if (unitCount === 3) {
    const bedsPerUnit = Math.max(1, Math.floor(totalBeds / 3));
    const extraBeds = totalBeds - bedsPerUnit * 3;
    const bathsPerUnit = Math.max(1, Math.floor(totalBaths / 3));

    units.push({ unitLabel: "Unit A", bedrooms: bedsPerUnit, bathrooms: bathsPerUnit, sqft: totalSqft ? Math.round(totalSqft * 0.28) : null, estimatedRent: null, isOwnerUnit: true });
    units.push({ unitLabel: "Unit B", bedrooms: bedsPerUnit + (extraBeds > 0 ? 1 : 0), bathrooms: bathsPerUnit, sqft: totalSqft ? Math.round(totalSqft * 0.36) : null, estimatedRent: null, isOwnerUnit: false });
    units.push({ unitLabel: "Unit C", bedrooms: bedsPerUnit + (extraBeds > 1 ? 1 : 0), bathrooms: bathsPerUnit, sqft: totalSqft ? Math.round(totalSqft * 0.36) : null, estimatedRent: null, isOwnerUnit: false });
  } else {
    const bedsPerUnit = Math.max(1, Math.floor(totalBeds / 4));
    const extraBeds = totalBeds - bedsPerUnit * 4;
    const bathsPerUnit = Math.max(1, Math.floor(totalBaths / 4));

    units.push({ unitLabel: "Unit A", bedrooms: bedsPerUnit, bathrooms: bathsPerUnit, sqft: totalSqft ? Math.round(totalSqft * 0.22) : null, estimatedRent: null, isOwnerUnit: true });
    for (let i = 1; i < 4; i++) {
      units.push({
        unitLabel: `Unit ${String.fromCharCode(65 + i)}`,
        bedrooms: bedsPerUnit + (extraBeds > i - 1 ? 1 : 0),
        bathrooms: bathsPerUnit,
        sqft: totalSqft ? Math.round(totalSqft * 0.26) : null,
        estimatedRent: null,
        isOwnerUnit: false,
      });
    }
  }

  return units;
}

async function enrichWithRentEstimates(
  rentcastKey: string,
  listings: RawMultiFamilyListing[],
  units: Map<string, UnitInfo[]>
): Promise<Map<string, UnitInfo[]>> {
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 600;
  const results = new Map(units);

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    const batch = listings.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (listing) => {
      const listingUnits = results.get(listing.id) || [];
      const enrichedUnits: UnitInfo[] = [];

      for (const unit of listingUnits) {
        const rent = await fetchRentEstimate(
          rentcastKey,
          `${listing.address}, ${listing.city}, ${listing.state} ${listing.zipCode}`,
          unit.bedrooms,
          unit.bathrooms,
          "Multi-Family"
        );
        enrichedUnits.push({ ...unit, estimatedRent: rent });
      }

      results.set(listing.id, enrichedUnits);
    });

    await Promise.all(promises);
    if (i + BATCH_SIZE < listings.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
}

// --- DEMO DATA ---

function generateDemoListings(
  location: string,
  unitCount?: string,
  bedrooms?: string,
  bathrooms?: string,
  minPrice?: number,
  maxPrice?: number
): { listings: RawMultiFamilyListing[]; unitMap: Map<string, UnitInfo[]> } {
  const seedStr = [
    location.toLowerCase().trim(),
    unitCount || "any",
    bedrooms || "any",
    bathrooms || "any",
    String(minPrice || 0),
    String(maxPrice || 0),
  ].join("|");
  const rand = createSeededRng(hashString(seedStr));

  const cities: Record<string, { city: string; state: string; zip: string; basePrice: number; baseRent: number; schoolBase: number; floodBase: number }> = {
    "94601": { city: "Oakland", state: "CA", zip: "94601", basePrice: 750000, baseRent: 2200, schoolBase: 5, floodBase: 2 },
    "94602": { city: "Oakland", state: "CA", zip: "94602", basePrice: 850000, baseRent: 2400, schoolBase: 6, floodBase: 1 },
    "33130": { city: "Miami", state: "FL", zip: "33130", basePrice: 550000, baseRent: 1800, schoolBase: 5, floodBase: 5 },
    "60601": { city: "Chicago", state: "IL", zip: "60601", basePrice: 480000, baseRent: 1600, schoolBase: 6, floodBase: 2 },
    "60614": { city: "Chicago", state: "IL", zip: "60614", basePrice: 650000, baseRent: 1900, schoolBase: 7, floodBase: 1 },
    "10001": { city: "New York", state: "NY", zip: "10001", basePrice: 1200000, baseRent: 2800, schoolBase: 6, floodBase: 3 },
    "78701": { city: "Austin", state: "TX", zip: "78701", basePrice: 520000, baseRent: 1500, schoolBase: 7, floodBase: 3 },
    "98101": { city: "Seattle", state: "WA", zip: "98101", basePrice: 680000, baseRent: 2000, schoolBase: 7, floodBase: 1 },
    "30301": { city: "Atlanta", state: "GA", zip: "30301", basePrice: 380000, baseRent: 1300, schoolBase: 6, floodBase: 2 },
    "80202": { city: "Denver", state: "CO", zip: "80202", basePrice: 550000, baseRent: 1700, schoolBase: 7, floodBase: 1 },
    "02101": { city: "Boston", state: "MA", zip: "02101", basePrice: 900000, baseRent: 2500, schoolBase: 7, floodBase: 2 },
    "19101": { city: "Philadelphia", state: "PA", zip: "19101", basePrice: 350000, baseRent: 1200, schoolBase: 5, floodBase: 2 },
  };

  const locLower = location.toLowerCase().trim();
  let config = cities[locLower];
  if (!config) {
    for (const [, c] of Object.entries(cities)) {
      if (c.city.toLowerCase().includes(locLower) || locLower.includes(c.city.toLowerCase())) {
        config = c;
        break;
      }
    }
  }
  if (!config) {
    config = { city: location, state: "US", zip: locLower.slice(0, 5) || "00000", basePrice: 500000, baseRent: 1600, schoolBase: 6, floodBase: 2 };
  }

  const unitCountFilter = unitCount && unitCount !== "any" ? parseInt(unitCount, 10) : null;
  const bedsFilter = bedrooms && bedrooms !== "any" ? parseInt(bedrooms, 10) : null;
  const bathsFilter = bathrooms && bathrooms !== "any" ? parseInt(bathrooms, 10) : null;

  const streets = ["Oak St", "Elm Ave", "Cedar Blvd", "Main St", "Pine Dr", "Maple Way", "Park Ave", "Lake Dr", "Hill Rd", "Grove Ln"];
  const schoolNames = ["Lincoln Elementary", "Washington Middle", "Jefferson High", "Roosevelt K-8", "Adams Academy", "Franklin Prep"];
  const parkingOptions: ParkingType[] = ["attached_garage", "detached_garage", "driveway", "street_only"];

  const listings: RawMultiFamilyListing[] = [];
  const unitMap = new Map<string, UnitInfo[]>();

  for (let i = 0; i < 20; i++) {
    const units = unitCountFilter || (rand() < 0.4 ? 2 : rand() < 0.7 ? 3 : 4);
    const totalBeds = bedsFilter || (units * (1 + Math.floor(rand() * 2)));
    const totalBaths = bathsFilter || Math.max(units, Math.floor(totalBeds * 0.7));

    const unitMultiplier = units === 2 ? 1 : units === 3 ? 1.4 : 1.75;
    const variance = 0.7 + rand() * 0.6;
    const price = Math.round(config.basePrice * unitMultiplier * variance / 1000) * 1000;

    if (minPrice && price < minPrice) continue;
    if (maxPrice && price > maxPrice) continue;

    const totalSqft = Math.round((units * (600 + rand() * 400)));
    const lotSizeSqft = Math.round(3000 + rand() * 8000);
    const yearBuilt = 1920 + Math.floor(rand() * 100);
    const daysOnMarket = Math.floor(rand() < 0.2 ? 90 + rand() * 120 : rand() * 80);
    const streetNum = 100 + Math.floor(rand() * 9900);

    // Parking
    const parkingType = parkingOptions[Math.floor(rand() * parkingOptions.length)];
    const garageSpaces = parkingType.includes("garage") ? Math.floor(1 + rand() * 3) : null;

    // Yard
    const hasPrivateYard = rand() < 0.6;
    const hasFrontYard = rand() < 0.5;
    const hasSideYard = rand() < 0.3;
    const hasFencedYard = hasPrivateYard && rand() < 0.5;

    // Schools
    const schoolVariance = Math.floor(rand() * 4) - 1;
    const avgSchoolRating = Math.min(10, Math.max(1, config.schoolBase + schoolVariance));
    const schools: SchoolInfo[] = [
      { name: schoolNames[i % 3], rating: Math.min(10, avgSchoolRating + Math.floor(rand() * 2)), level: "elementary", distanceMiles: Math.round(rand() * 15) / 10 + 0.2 },
      { name: schoolNames[(i % 3) + 3], rating: Math.min(10, avgSchoolRating + Math.floor(rand() * 3) - 1), level: "high", distanceMiles: Math.round(rand() * 25) / 10 + 0.5 },
    ];

    // Flood
    const floodVariance = Math.floor(rand() * 3) - 1;
    const floodFactorScore = Math.min(10, Math.max(1, config.floodBase + floodVariance));
    const femaZone = floodFactorScore <= 2 ? "X (unshaded)" : floodFactorScore <= 5 ? "X (shaded)" : "AE";

    // Value estimate
    const estimateVariance = (rand() - 0.4) * 0.25;
    const estimatedValue = Math.round(price * (1 + estimateVariance) / 1000) * 1000;

    // Price reductions
    const priceReductions: PriceReduction[] = [];
    let originalListPrice: number | null = null;
    if (rand() < 0.3) {
      const numReductions = rand() < 0.6 ? 1 : 2;
      let prevPrice = Math.round(price * (1.05 + rand() * 0.15) / 1000) * 1000;
      originalListPrice = prevPrice;
      for (let r = 0; r < numReductions; r++) {
        const dropPct = 2 + rand() * 6;
        const newPrice = r === numReductions - 1 ? price : Math.round(prevPrice * (1 - dropPct / 100) / 1000) * 1000;
        const dropAmount = prevPrice - newPrice;
        priceReductions.push({
          date: `2026-0${Math.max(1, 3 - numReductions + r)}-${10 + Math.floor(rand() * 18)}`,
          previousPrice: prevPrice, newPrice, dropAmount,
          dropPercent: Math.round((dropAmount / prevPrice) * 1000) / 10,
        });
        prevPrice = newPrice;
      }
    }

    const stableId = `demo-${locLower}-${i}`;

    const listing: RawMultiFamilyListing = {
      id: stableId,
      address: `${streetNum} ${streets[i % streets.length]}`,
      city: config.city, state: config.state, zipCode: config.zip,
      price, totalBedrooms: totalBeds, totalBathrooms: totalBaths,
      totalSqft, lotSizeSqft, unitCount: units,
      yearBuilt, daysOnMarket,
      listingUrl: null, photoUrl: null,
      source: "Demo Data",
      avgSchoolRating, schools, floodFactorScore, femaZone,
      estimatedValue, priceReductions, originalListPrice,
      parkingType, garageSpaces,
      hasPrivateYard, hasFrontYard, hasSideYard, hasFencedYard,
      descriptionText: null,
    };

    // Generate unit breakdown with deterministic rent
    const unitInfos = estimateUnitBreakdown(totalBeds, totalBaths, totalSqft, units, rand);
    // Assign deterministic rent estimates
    for (const unit of unitInfos) {
      const rentMultiplier = unit.bedrooms === 1 ? 0.65 : unit.bedrooms === 2 ? 1 : 1.3;
      const rentVariance = 0.85 + rand() * 0.3;
      unit.estimatedRent = Math.round(config.baseRent * rentMultiplier * rentVariance / 10) * 10;
    }

    listings.push(listing);
    unitMap.set(stableId, unitInfos);
  }

  return { listings, unitMap };
}

// --- PROCESS LISTINGS ---

function processListings(
  raw: RawMultiFamilyListing[],
  unitMap: Map<string, UnitInfo[]>,
  params: SearchParams
): SearchResult {
  if (raw.length === 0) {
    return {
      listings: [],
      marketStats: {
        medianPrice: 0, medianRent: 0, medianPricePerUnit: 0,
        totalListings: 0, avgDaysOnMarket: 0, avgMortgageOffset: 0,
        location: params.location,
      },
      searchParams: params,
    };
  }

  const currentYear = new Date().getFullYear();
  const loanType: LoanType = params.loanType || "fha";
  const loanConfig = getLoanConfig(loanType);

  const processed: HouseHackListing[] = raw.map((r) => {
    const units = unitMap.get(r.id) || [];
    const monthlyPITI = calculatePITI(r.price, loanType);

    const rentedUnits = units.filter(u => !u.isOwnerUnit);
    const ownerUnit = units.find(u => u.isOwnerUnit);

    const rentalUnitIncome = rentedUnits.reduce((s, u) => s + (u.estimatedRent || 0), 0);
    const ownerUnitRent = ownerUnit?.estimatedRent || null;
    const totalEstimatedRent = units.reduce((s, u) => s + (u.estimatedRent || 0), 0);

    const mortgageOffsetPercent = monthlyPITI > 0 && rentalUnitIncome > 0
      ? Math.round((rentalUnitIncome / monthlyPITI) * 1000) / 10
      : null;

    const ownerNetMonthlyCost = rentalUnitIncome > 0
      ? monthlyPITI - rentalUnitIncome
      : null;

    // Cash flow with vacancy rate and expense ratio
    const vacancyRate = 0.08; // 8% industry standard vacancy
    const expenseRate = r.yearBuilt && (currentYear - r.yearBuilt) > 30 ? 0.45 : 0.35;

    const annualGrossRent = rentalUnitIncome > 0 ? rentalUnitIncome * 12 : null;
    const annualVacancyLoss = annualGrossRent !== null ? Math.round(annualGrossRent * vacancyRate) : null;
    const effectiveGrossIncome = annualGrossRent !== null && annualVacancyLoss !== null
      ? annualGrossRent - annualVacancyLoss
      : null;
    const annualOperatingExpenses = effectiveGrossIncome !== null
      ? Math.round(effectiveGrossIncome * expenseRate)
      : null;
    const netOperatingIncome = effectiveGrossIncome !== null && annualOperatingExpenses !== null
      ? effectiveGrossIncome - annualOperatingExpenses
      : null;

    const annualDebt = monthlyPITI * 12;
    const annualCashFlow = netOperatingIncome !== null
      ? Math.round(netOperatingIncome - annualDebt)
      : null;
    const monthlyCashFlow = annualCashFlow !== null
      ? Math.round(annualCashFlow / 12)
      : null;

    const totalCashInvested = getTotalCashInvested(r.price, loanType);
    const cashOnCashReturn = annualCashFlow !== null && totalCashInvested > 0
      ? Math.round((annualCashFlow / totalCashInvested) * 1000) / 10
      : null;

    // Cap rate
    const capRate = netOperatingIncome !== null && r.price > 0
      ? Math.round((netOperatingIncome / r.price) * 1000) / 10
      : null;

    // GRM
    const grossRentMultiplier = totalEstimatedRent > 0
      ? Math.round((r.price / (totalEstimatedRent * 12)) * 10) / 10
      : null;

    const buildingAge = r.yearBuilt ? currentYear - r.yearBuilt : null;
    const lotSizeAcres = r.lotSizeSqft ? Math.round((r.lotSizeSqft / 43560) * 100) / 100 : null;

    const yardScore = (r.hasPrivateYard ? 1 : 0) + (r.hasFrontYard ? 1 : 0) + (r.hasSideYard ? 1 : 0) + (r.hasFencedYard ? 1 : 0);

    const valueGapPercent = r.estimatedValue && r.estimatedValue > 0
      ? Math.round(((r.price - r.estimatedValue) / r.estimatedValue) * 1000) / 10
      : null;

    const totalPriceReduction = r.priceReductions.length > 0
      ? r.priceReductions.reduce((sum, pr) => sum + pr.dropAmount, 0)
      : null;
    const totalReductionPercent = totalPriceReduction !== null && r.originalListPrice
      ? Math.round((totalPriceReduction / r.originalListPrice) * 1000) / 10
      : null;

    // Price metrics
    const pricePerSqft = r.totalSqft && r.totalSqft > 0 ? Math.round(r.price / r.totalSqft) : null;
    const pricePerUnit = Math.round(r.price / r.unitCount);

    // Days since last price reduction
    let daysSinceLastReduction: number | null = null;
    if (r.priceReductions.length > 0) {
      const lastCut = r.priceReductions[r.priceReductions.length - 1];
      const cutDate = new Date(lastCut.date);
      daysSinceLastReduction = Math.floor((Date.now() - cutDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Negotiation signals
    const negotiationSignals: NegotiationSignal[] = [];

    // 1. Days on market signals
    if (r.daysOnMarket !== null) {
      if (r.daysOnMarket >= 180) {
        negotiationSignals.push({
          strength: "strong",
          label: "Extended Time on Market",
          detail: `${r.daysOnMarket} days on market — well above average. Seller likely highly motivated. Consider offering 10-15% below ask.`,
        });
      } else if (r.daysOnMarket >= 90) {
        negotiationSignals.push({
          strength: "moderate",
          label: "Above-Average Market Time",
          detail: `${r.daysOnMarket} days on market indicates reduced buyer interest. Seller may be flexible on price or terms.`,
        });
      } else if (r.daysOnMarket >= 45) {
        negotiationSignals.push({
          strength: "info",
          label: "Moderate Market Time",
          detail: `${r.daysOnMarket} days on market — approaching stale. May accept offers 3-5% below ask.`,
        });
      }
    }

    // 2. Price reduction signals
    if (r.priceReductions.length > 0 && totalReductionPercent !== null) {
      if (r.priceReductions.length >= 3) {
        negotiationSignals.push({
          strength: "strong",
          label: "Multiple Price Cuts",
          detail: `${r.priceReductions.length} price reductions totaling ${totalReductionPercent}% (${fmtUSD(totalPriceReduction!)}). Seller is chasing the market down — strong negotiation position.`,
        });
      } else if (totalReductionPercent >= 8) {
        negotiationSignals.push({
          strength: "strong",
          label: "Significant Price Reduction",
          detail: `Price cut ${totalReductionPercent}% (${fmtUSD(totalPriceReduction!)}) from original ${fmtUSD(r.originalListPrice!)}. Seller has shown willingness to accept lower offers.`,
        });
      } else if (totalReductionPercent >= 3) {
        negotiationSignals.push({
          strength: "moderate",
          label: "Price Reduced",
          detail: `Reduced ${totalReductionPercent}% (${fmtUSD(totalPriceReduction!)}) from ${fmtUSD(r.originalListPrice!)}. Seller is negotiating with the market.`,
        });
      } else {
        negotiationSignals.push({
          strength: "info",
          label: "Minor Price Adjustment",
          detail: `Small reduction of ${totalReductionPercent}% (${fmtUSD(totalPriceReduction!)}). Likely a market correction rather than distress.`,
        });
      }
    }

    // 3. Recent price cut (timing matters)
    if (daysSinceLastReduction !== null && daysSinceLastReduction <= 14) {
      negotiationSignals.push({
        strength: "strong",
        label: "Very Recent Price Cut",
        detail: `Price reduced ${daysSinceLastReduction} days ago — seller is actively adjusting. Momentum is in your favor. Act quickly with a below-ask offer.`,
      });
    } else if (daysSinceLastReduction !== null && daysSinceLastReduction <= 30) {
      negotiationSignals.push({
        strength: "moderate",
        label: "Recent Price Cut",
        detail: `Last price reduction was ${daysSinceLastReduction} days ago. Seller recently acknowledged need to adjust.`,
      });
    }

    // 4. Value gap (priced above or below estimates)
    if (valueGapPercent !== null) {
      if (valueGapPercent >= 8) {
        negotiationSignals.push({
          strength: "strong",
          label: "Priced Above Estimated Value",
          detail: `Listed ${valueGapPercent}% above estimated value of ${fmtUSD(r.estimatedValue!)}. Gap of ${fmtUSD(Math.round(r.price - r.estimatedValue!))} supports a lower offer.`,
        });
      } else if (valueGapPercent >= 3) {
        negotiationSignals.push({
          strength: "moderate",
          label: "Slightly Above Value",
          detail: `Listed ${valueGapPercent}% above estimated value (${fmtUSD(r.estimatedValue!)}). Some room to negotiate toward market value.`,
        });
      } else if (valueGapPercent <= -5) {
        negotiationSignals.push({
          strength: "info",
          label: "Priced Below Estimated Value",
          detail: `Listed ${Math.abs(valueGapPercent)}% below estimated value of ${fmtUSD(r.estimatedValue!)}. Already competitively priced — less room to negotiate on price, focus on terms.`,
        });
      }
    }

    // 5. Building age and maintenance leverage
    if (buildingAge !== null && buildingAge >= 70) {
      negotiationSignals.push({
        strength: "moderate",
        label: "Aging Property",
        detail: `Built ${r.yearBuilt} (${buildingAge} yrs old). Major systems (roof, plumbing, electrical) may need updating. Request inspection credits or negotiate a maintenance reserve.`,
      });
    } else if (buildingAge !== null && buildingAge >= 40) {
      negotiationSignals.push({
        strength: "info",
        label: "Older Construction",
        detail: `Built ${r.yearBuilt} (${buildingAge} yrs old). Factor in potential maintenance costs. Ask about recent repairs and capital improvements.`,
      });
    }

    // 6. Price per unit vs market (will be enhanced when market data available)
    if (pricePerSqft !== null && pricePerSqft > 0) {
      negotiationSignals.push({
        strength: "info",
        label: "Price Metrics",
        detail: `${fmtUSD(pricePerSqft)}/sqft · ${fmtUSD(pricePerUnit)}/unit. Compare against recent comps to gauge pricing.`,
      });
    }

    // Rent control
    const rcInfo = getRentControlInfo(r.state, r.city, r.unitCount);

    const base = {
      ...r,
      buildingAge,
      lotSizeAcres,
      units,
      totalEstimatedRent,
      ownerUnitRent,
      rentalUnitIncome,
      loanType,
      downPaymentPercent: loanConfig.downPaymentPct * 100,
      fundingFeePercent: loanConfig.fundingFeePct * 100,
      totalCashInvested,
      monthlyPITI,
      mortgageOffsetPercent,
      ownerNetMonthlyCost,
      annualCashFlow,
      monthlyCashFlow,
      cashOnCashReturn,
      capRate,
      grossRentMultiplier,
      vacancyRate,
      annualGrossRent,
      annualVacancyLoss,
      effectiveGrossIncome,
      annualOperatingExpenses,
      netOperatingIncome,
      expenseRate,
      yardScore,
      pricePerSqft,
      pricePerUnit,
      valueGapPercent,
      totalPriceReduction,
      totalReductionPercent,
      daysSinceLastReduction,
      negotiationSignals,
      rentControlStatus: rcInfo.status,
      rentControlMaxIncrease: rcInfo.maxIncrease,
      rentControlNotes: rcInfo.notes,
      ownerOccupiedExempt: rcInfo.ownerOccupiedDuplexExempt,
    };

    const scoring = calculateDealScore(base, {
      medianPrice: 0, medianRent: 0, medianPricePerUnit: 0,
      totalListings: 0, avgDaysOnMarket: 0, avgMortgageOffset: 0,
      location: params.location,
    });

    return { ...base, ...scoring };
  });

  // Market stats
  const prices = processed.map(l => l.price).sort((a, b) => a - b);
  const rents = processed.filter(l => l.rentalUnitIncome).map(l => l.rentalUnitIncome!).sort((a, b) => a - b);
  const doms = processed.filter(l => l.daysOnMarket !== null).map(l => l.daysOnMarket!);
  const offsets = processed.filter(l => l.mortgageOffsetPercent !== null).map(l => l.mortgageOffsetPercent!);

  const median = (arr: number[]) => arr.length === 0 ? 0 : arr[Math.floor(arr.length / 2)];
  const avg = (arr: number[]) => arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

  const stats: MarketStats = {
    medianPrice: median(prices),
    medianRent: median(rents),
    medianPricePerUnit: Math.round(median(prices) / (processed.reduce((s, l) => s + l.unitCount, 0) / processed.length)),
    totalListings: processed.length,
    avgDaysOnMarket: avg(doms),
    avgMortgageOffset: avg(offsets),
    location: params.location,
  };

  // Sort
  const sortBy = params.sortBy || "score";
  processed.sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "score": cmp = b.dealScore - a.dealScore; break;
      case "price_low": cmp = a.price - b.price; break;
      case "price_high": cmp = b.price - a.price; break;
      case "offset_high": cmp = (b.mortgageOffsetPercent || 0) - (a.mortgageOffsetPercent || 0); break;
      case "cashflow_high": cmp = (b.annualCashFlow || -99999) - (a.annualCashFlow || -99999); break;
      default: cmp = b.dealScore - a.dealScore;
    }
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });

  return { listings: processed, marketStats: stats, searchParams: params };
}

// --- ROUTES ---

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  app.post("/api/config", (req, res) => {
    const { realtyApiKey, rentcastApiKey } = req.body;
    if (realtyApiKey) storedRealtyKey = realtyApiKey;
    if (rentcastApiKey) storedRentcastKey = rentcastApiKey;
    res.json({ success: true, hasRealtyKey: !!storedRealtyKey, hasRentcastKey: !!storedRentcastKey });
  });

  app.get("/api/config/status", (_req, res) => {
    res.json({ hasRealtyKey: !!storedRealtyKey, hasRentcastKey: !!storedRentcastKey });
  });

  app.post("/api/search", async (req, res) => {
    try {
      const params = searchParamsSchema.parse(req.body);

      let rawListings: RawMultiFamilyListing[];
      let unitMap: Map<string, UnitInfo[]>;

      if (storedRealtyKey) {
        try {
          rawListings = await fetchFromRealtorAPI(
            storedRealtyKey, params.location, params.unitCount,
            params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
          );
          // Generate unit breakdowns
          const dummyRand = createSeededRng(hashString(params.location));
          unitMap = new Map();
          for (const l of rawListings) {
            unitMap.set(l.id, estimateUnitBreakdown(l.totalBedrooms, l.totalBathrooms, l.totalSqft, l.unitCount, dummyRand));
          }
          // Enrich with RentCast if available
          if (storedRentcastKey) {
            unitMap = await enrichWithRentEstimates(storedRentcastKey, rawListings, unitMap);
          } else {
            // Fallback: estimate rents from price
            for (const l of rawListings) {
              const units = unitMap.get(l.id) || [];
              const baseRent = Math.round(l.price * 0.005); // 0.5% rule rough estimate
              for (const unit of units) {
                const bedMult = unit.bedrooms === 1 ? 0.7 : unit.bedrooms === 2 ? 1 : 1.25;
                unit.estimatedRent = Math.round((baseRent / l.unitCount) * bedMult / 10) * 10;
              }
            }
          }
        } catch (apiError: any) {
          console.error("API error, falling back to demo:", apiError.message);
          const demo = generateDemoListings(
            params.location, params.unitCount,
            params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
          );
          rawListings = demo.listings;
          unitMap = demo.unitMap;
        }
      } else {
        const demo = generateDemoListings(
          params.location, params.unitCount,
          params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
        );
        rawListings = demo.listings;
        unitMap = demo.unitMap;
      }

      const result = processListings(rawListings, unitMap, params);
      res.json(result);
    } catch (err: any) {
      console.error("Search error:", err);
      res.status(400).json({ error: err.message || "Search failed" });
    }
  });

  app.post("/api/search/demo", (req, res) => {
    try {
      const params = searchParamsSchema.parse(req.body);
      const demo = generateDemoListings(
        params.location, params.unitCount,
        params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
      );
      const result = processListings(demo.listings, demo.unitMap, params);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Demo search failed" });
    }
  });

  // CSV Export endpoint — returns search results as downloadable CSV
  app.post("/api/export/csv", async (req, res) => {
    try {
      const params = searchParamsSchema.parse(req.body);
      let rawListings: RawMultiFamilyListing[];
      let unitMap: Map<string, UnitInfo[]>;

      if (storedRealtyKey) {
        try {
          rawListings = await fetchFromRealtorAPI(
            storedRealtyKey, params.location, params.unitCount,
            params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
          );
          const dummyRand = createSeededRng(hashString(params.location));
          unitMap = new Map();
          for (const l of rawListings) {
            unitMap.set(l.id, estimateUnitBreakdown(l.totalBedrooms, l.totalBathrooms, l.totalSqft, l.unitCount, dummyRand));
          }
          if (storedRentcastKey) {
            unitMap = await enrichWithRentEstimates(storedRentcastKey, rawListings, unitMap);
          } else {
            for (const l of rawListings) {
              const units = unitMap.get(l.id) || [];
              const baseRent = Math.round(l.price * 0.005);
              for (const unit of units) {
                const bedMult = unit.bedrooms === 1 ? 0.7 : unit.bedrooms === 2 ? 1 : 1.25;
                unit.estimatedRent = Math.round((baseRent / l.unitCount) * bedMult / 10) * 10;
              }
            }
          }
        } catch {
          const demo = generateDemoListings(params.location, params.unitCount, params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice);
          rawListings = demo.listings;
          unitMap = demo.unitMap;
        }
      } else {
        const demo = generateDemoListings(params.location, params.unitCount, params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice);
        rawListings = demo.listings;
        unitMap = demo.unitMap;
      }

      const result = processListings(rawListings, unitMap, params);

      // Build CSV
      const headers = [
        "Score", "Label", "Address", "City", "State", "ZIP",
        "Price", "Units", "Beds", "Baths", "Sqft", "Year Built", "Lot Sqft",
        "Days on Market", "Listing URL",
        "Loan Type", "Down Payment %", "Monthly PITI",
        "Rental Income/mo", "Owner Cost/mo",
        "PITI Offset %", "Monthly Cash Flow", "Annual Cash Flow",
        "Vacancy Rate", "Expense Rate",
        "Gross Rent/yr", "Vacancy Loss/yr", "Effective Gross Income/yr",
        "Operating Expenses/yr", "NOI/yr",
        "Cash-on-Cash %", "Cap Rate %", "GRM", "Total Cash Invested",
        "Parking", "School Rating", "Flood Score",
        "Estimated Value", "Value Gap %", "Price/Sqft", "Price/Unit",
        "Original List Price", "Total Price Reduction", "Reduction %", "# Price Cuts",
        "Rent Control", "Rent Control Notes",
        "Negotiation Signals",
      ];

      const csvEscape = (val: any): string => {
        if (val === null || val === undefined) return "";
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      const rows = result.listings.map(l => [
        l.dealScore, l.scoreLabel, l.address, l.city, l.state, l.zipCode,
        l.price, l.unitCount, l.totalBedrooms, l.totalBathrooms, l.totalSqft, l.yearBuilt, l.lotSizeSqft,
        l.daysOnMarket, l.listingUrl || "",
        l.loanType, l.downPaymentPercent, l.monthlyPITI,
        l.rentalUnitIncome, l.ownerNetMonthlyCost,
        l.mortgageOffsetPercent, l.monthlyCashFlow, l.annualCashFlow,
        Math.round(l.vacancyRate * 100), Math.round(l.expenseRate * 100),
        l.annualGrossRent, l.annualVacancyLoss, l.effectiveGrossIncome,
        l.annualOperatingExpenses, l.netOperatingIncome,
        l.cashOnCashReturn, l.capRate, l.grossRentMultiplier, l.totalCashInvested,
        l.parkingType, l.avgSchoolRating, l.floodFactorScore,
        l.estimatedValue, l.valueGapPercent, l.pricePerSqft, l.pricePerUnit,
        l.originalListPrice, l.totalPriceReduction, l.totalReductionPercent, l.priceReductions.length,
        l.rentControlStatus, l.rentControlNotes,
        l.negotiationSignals.map(s => `[${s.strength.toUpperCase()}] ${s.label}: ${s.detail}`).join(" | "),
      ]);

      const csv = [headers.map(csvEscape).join(","), ...rows.map(r => r.map(csvEscape).join(","))].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="househackscore-${params.location.replace(/[^a-zA-Z0-9]/g, "_")}.csv"`);
      res.send(csv);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Export failed" });
    }
  });

  // JSON export for Google Sheets integration
  app.post("/api/export/json", async (req, res) => {
    try {
      const params = searchParamsSchema.parse(req.body);
      let rawListings: RawMultiFamilyListing[];
      let unitMap: Map<string, UnitInfo[]>;

      if (storedRealtyKey) {
        try {
          rawListings = await fetchFromRealtorAPI(
            storedRealtyKey, params.location, params.unitCount,
            params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice
          );
          const dummyRand = createSeededRng(hashString(params.location));
          unitMap = new Map();
          for (const l of rawListings) {
            unitMap.set(l.id, estimateUnitBreakdown(l.totalBedrooms, l.totalBathrooms, l.totalSqft, l.unitCount, dummyRand));
          }
          if (storedRentcastKey) {
            unitMap = await enrichWithRentEstimates(storedRentcastKey, rawListings, unitMap);
          } else {
            for (const l of rawListings) {
              const units = unitMap.get(l.id) || [];
              const baseRent = Math.round(l.price * 0.005);
              for (const unit of units) {
                const bedMult = unit.bedrooms === 1 ? 0.7 : unit.bedrooms === 2 ? 1 : 1.25;
                unit.estimatedRent = Math.round((baseRent / l.unitCount) * bedMult / 10) * 10;
              }
            }
          }
        } catch {
          const demo = generateDemoListings(params.location, params.unitCount, params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice);
          rawListings = demo.listings;
          unitMap = demo.unitMap;
        }
      } else {
        const demo = generateDemoListings(params.location, params.unitCount, params.bedrooms, params.bathrooms, params.minPrice, params.maxPrice);
        rawListings = demo.listings;
        unitMap = demo.unitMap;
      }

      const result = processListings(rawListings, unitMap, params);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Export failed" });
    }
  });

  return httpServer;
}
