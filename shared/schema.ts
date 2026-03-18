import { z } from "zod";

// Loan type
export type LoanType = "fha" | "va_first" | "va_subsequent" | "va_disabled";

export const LOAN_LABELS: Record<LoanType, string> = {
  fha: "FHA (3.5% Down)",
  va_first: "VA First Use (0% Down)",
  va_subsequent: "VA Subsequent (0% Down)",
  va_disabled: "VA Disabled (0% Down, No Fee)",
};

// Search parameters
export const searchParamsSchema = z.object({
  location: z.string().min(1, "Location is required"),
  unitCount: z.enum(["any", "2", "3", "4"]).optional().default("any"),
  bedrooms: z.string().optional(),
  bathrooms: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  sortBy: z.enum(["score", "price_low", "price_high", "offset_high", "cashflow_high"]).optional().default("score"),
  loanType: z.enum(["fha", "va_first", "va_subsequent", "va_disabled"]).optional().default("fha"),
});

export type SearchParams = z.infer<typeof searchParamsSchema>;

// Unit breakdown for multi-family
export interface UnitInfo {
  unitLabel: string;           // "Unit A", "Unit B", etc.
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  estimatedRent: number | null; // From RentCast
  isOwnerUnit: boolean;         // Suggested smallest unit for owner
}

// School info
export interface SchoolInfo {
  name: string;
  rating: number | null;
  level: string;
  distanceMiles: number;
}

// Price reduction event
export interface PriceReduction {
  date: string;
  previousPrice: number;
  newPrice: number;
  dropAmount: number;
  dropPercent: number;
}

// Parking classification
export type ParkingType = "attached_garage" | "detached_garage" | "driveway" | "street_only" | "unknown";

export const PARKING_LABELS: Record<ParkingType, string> = {
  attached_garage: "Attached Garage",
  detached_garage: "Detached / External Garage",
  driveway: "Driveway / Off-Street",
  street_only: "Street Parking Only",
  unknown: "Unknown",
};

// Main listing interface
export interface HouseHackListing {
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
  lotSizeAcres: number | null;
  unitCount: number;               // 2, 3, or 4
  yearBuilt: number | null;
  buildingAge: number | null;
  daysOnMarket: number | null;
  listingUrl: string | null;
  photoUrl: string | null;
  source: string;

  // Unit breakdown
  units: UnitInfo[];
  totalEstimatedRent: number | null;     // Sum of all rented units' estimated rent
  ownerUnitRent: number | null;          // What the owner's unit COULD rent for
  rentalUnitIncome: number | null;       // Total rent from non-owner units

  // Loan info
  loanType: LoanType;
  downPaymentPercent: number;            // 3.5% FHA or 0% VA
  fundingFeePercent: number;             // VA funding fee (0-3.3%) or 0 for FHA
  totalCashInvested: number;             // Down payment + closing costs + funding fee (if not rolled in)

  // Financial analysis
  monthlyPITI: number;                   // Principal + Interest + Tax + Insurance estimate
  mortgageOffsetPercent: number | null;  // rentalUnitIncome / monthlyPITI * 100
  ownerNetMonthlyCost: number | null;    // monthlyPITI - rentalUnitIncome
  annualCashFlow: number | null;         // (rentalUnitIncome * 12) - (monthlyPITI * 12) - (expenses)
  monthlyCashFlow: number | null;        // annualCashFlow / 12
  cashOnCashReturn: number | null;       // annualCashFlow / totalCashInvested * 100
  capRate: number | null;                // NOI / price * 100
  grossRentMultiplier: number | null;    // price / (totalEstimatedRent * 12)

  // Vacancy & operating breakdown
  vacancyRate: number;                   // Vacancy rate used (e.g. 0.08 = 8%)
  annualGrossRent: number | null;        // rentalUnitIncome * 12 (before vacancy)
  annualVacancyLoss: number | null;      // annualGrossRent * vacancyRate
  effectiveGrossIncome: number | null;   // annualGrossRent - annualVacancyLoss
  annualOperatingExpenses: number | null; // effectiveGrossIncome * expenseRate
  netOperatingIncome: number | null;     // effectiveGrossIncome - annualOperatingExpenses
  expenseRate: number;                   // 0.35 or 0.45 based on building age

  // Rent control
  rentControlStatus: RentControlStatus;
  rentControlMaxIncrease: number | null; // Max annual rent increase % if applicable
  rentControlNotes: string | null;       // Human-readable explanation
  ownerOccupiedExempt: boolean;          // Whether owner-occupied duplex is exempt

  // Physical features
  parkingType: ParkingType;
  garageSpaces: number | null;
  hasPrivateYard: boolean;
  hasFrontYard: boolean;
  hasSideYard: boolean;
  hasFencedYard: boolean;
  yardScore: number;                     // 0-4 count of yard features

  // Location & environment
  avgSchoolRating: number | null;
  schools: SchoolInfo[];
  floodFactorScore: number | null;
  femaZone: string | null;

  // Value analysis
  estimatedValue: number | null;
  valueGapPercent: number | null;
  pricePerSqft: number | null;
  pricePerUnit: number;

  // Price history & negotiation
  priceReductions: PriceReduction[];
  totalPriceReduction: number | null;
  totalReductionPercent: number | null;
  originalListPrice: number | null;
  daysSinceLastReduction: number | null;
  negotiationSignals: NegotiationSignal[];

  // Scoring
  dealScore: number;
  scoreBreakdown: ScoreBreakdown;
  scoreLabel: "Excellent Hack" | "Strong Hack" | "Decent Hack" | "Weak Hack" | "Pass";
}

export interface ScoreBreakdown {
  mortgageOffsetScore: number;     // 0-20 pts: rental income covering PITI
  ownerCostScore: number;          // 0-15 pts: net owner monthly cost
  cashOnCashScore: number;         // 0-10 pts: return on investment
  buildingAgeScore: number;        // 0-10 pts: maintenance risk
  schoolQualityScore: number;      // 0-8 pts: school ratings
  floodRiskScore: number;          // 0-4 pts: flood exposure
  parkingScore: number;            // 0-8 pts: garage > driveway > street
  yardSpaceScore: number;          // 0-5 pts: yard features
  unitConfigScore: number;         // 0-10 pts: uneven split + more units
  lotSizeScore: number;            // 0-5 pts: larger lots
  priceReductionBonus: number;     // 0-5 pts: bonus for price cuts
}

// Rent control classification
export type RentControlStatus = "none" | "state_cap" | "local_control" | "exempt_owner_occupied";

export const RENT_CONTROL_LABELS: Record<RentControlStatus, string> = {
  none: "No Rent Control",
  state_cap: "State Rent Cap",
  local_control: "Local Rent Control",
  exempt_owner_occupied: "Exempt (Owner-Occupied)",
};

// Negotiation signal
export type NegotiationStrength = "strong" | "moderate" | "info";

export interface NegotiationSignal {
  strength: NegotiationStrength;   // strong = major leverage, moderate = useful, info = context
  label: string;                   // Short title, e.g. "Extended Time on Market"
  detail: string;                  // Explanation with specific numbers
}

export const SIGNAL_COLORS: Record<NegotiationStrength, string> = {
  strong: "text-emerald-700 dark:text-emerald-400",
  moderate: "text-blue-700 dark:text-blue-400",
  info: "text-muted-foreground",
};

export const SIGNAL_BG: Record<NegotiationStrength, string> = {
  strong: "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800",
  moderate: "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800",
  info: "bg-muted/50 border-border",
};

export interface MarketStats {
  medianPrice: number;
  medianRent: number;
  medianPricePerUnit: number;
  totalListings: number;
  avgDaysOnMarket: number;
  avgMortgageOffset: number;
  location: string;
}

export interface SearchResult {
  listings: HouseHackListing[];
  marketStats: MarketStats;
  searchParams: SearchParams;
}

// API config
export const apiConfigSchema = z.object({
  realtyApiKey: z.string().optional(),
  rentcastApiKey: z.string().optional(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
