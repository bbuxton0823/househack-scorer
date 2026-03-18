import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Home as HomeIcon, TrendingUp, TrendingDown, DollarSign,
  Building2, Car, TreePine, GraduationCap, Droplets, MapPin,
  ChevronDown, ChevronUp, Tag, AlertTriangle, Info, Percent,
  BarChart3, ArrowUpRight, Key, CheckCircle2, XCircle, Settings,
  Shield, ShieldCheck, ShieldAlert, ShieldX, Download, Handshake,
  Zap, Clock, CircleDollarSign,
} from "lucide-react";
import type {
  SearchResult, HouseHackListing, ScoreBreakdown, MarketStats, SearchParams,
  ParkingType, UnitInfo, LoanType, RentControlStatus, NegotiationSignal, NegotiationStrength,
} from "@shared/schema";
import { PARKING_LABELS, LOAN_LABELS, RENT_CONTROL_LABELS, SIGNAL_COLORS, SIGNAL_BG } from "@shared/schema";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

// ----- Constants -----

const SCORE_COLORS: Record<string, string> = {
  "Excellent Hack": "text-emerald-600 dark:text-emerald-400",
  "Strong Hack": "text-blue-600 dark:text-blue-400",
  "Decent Hack": "text-amber-600 dark:text-amber-400",
  "Weak Hack": "text-orange-600 dark:text-orange-400",
  "Pass": "text-red-600 dark:text-red-400",
};

const SCORE_BG: Record<string, string> = {
  "Excellent Hack": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "Strong Hack": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  "Decent Hack": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Weak Hack": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "Pass": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const DIMENSION_INFO: Record<keyof ScoreBreakdown, { label: string; max: number; icon: any; color: string }> = {
  mortgageOffsetScore: { label: "Mortgage Offset", max: 20, icon: Percent, color: "bg-blue-500" },
  ownerCostScore: { label: "Owner Net Cost", max: 15, icon: DollarSign, color: "bg-emerald-500" },
  cashOnCashScore: { label: "Cash-on-Cash", max: 10, icon: TrendingUp, color: "bg-teal-500" },
  buildingAgeScore: { label: "Building Age", max: 10, icon: Building2, color: "bg-slate-500" },
  schoolQualityScore: { label: "School Quality", max: 8, icon: GraduationCap, color: "bg-purple-500" },
  floodRiskScore: { label: "Flood Risk", max: 4, icon: Droplets, color: "bg-cyan-500" },
  parkingScore: { label: "Parking", max: 8, icon: Car, color: "bg-amber-500" },
  yardSpaceScore: { label: "Yard Space", max: 5, icon: TreePine, color: "bg-green-500" },
  unitConfigScore: { label: "Unit Config", max: 10, icon: HomeIcon, color: "bg-indigo-500" },
  lotSizeScore: { label: "Lot Size", max: 5, icon: MapPin, color: "bg-orange-500" },
  priceReductionBonus: { label: "Price Cut Bonus", max: 5, icon: Tag, color: "bg-rose-500" },
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  return n.toLocaleString("en-US");
}

function fmtCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  return "$" + n.toLocaleString("en-US");
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "N/A";
  return n.toFixed(1) + "%";
}

// ----- API Config Panel -----

function ApiConfigPanel() {
  const [realtyKey, setRealtyKey] = useState("");
  const [rentcastKey, setRentcastKey] = useState("");
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const { data: status } = useQuery<{ hasRealtyKey: boolean; hasRentcastKey: boolean }>({
    queryKey: ["/api/config/status"],
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {};
      if (realtyKey.trim()) body.realtyApiKey = realtyKey.trim();
      if (rentcastKey.trim()) body.rentcastApiKey = rentcastKey.trim();
      return apiRequest("POST", "/api/config", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config/status"] });
      toast({ title: "API keys saved", description: "Your keys are stored for this session." });
      setRealtyKey("");
      setRentcastKey("");
    },
  });

  const hasRealty = status?.hasRealtyKey ?? false;
  const hasRentcast = status?.hasRentcastKey ?? false;

  return (
    <div className="mb-4" data-testid="api-config-panel">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        data-testid="toggle-api-config"
      >
        <Settings className="w-3.5 h-3.5" />
        <span>API Keys</span>
        <span className="flex items-center gap-1.5 ml-2">
          {hasRealty ? (
            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> Realty
            </span>
          ) : (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <XCircle className="w-3 h-3" /> Realty
            </span>
          )}
          {hasRentcast ? (
            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> RentCast
            </span>
          ) : (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <XCircle className="w-3 h-3" /> RentCast
            </span>
          )}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="mt-3 p-4 rounded-lg border bg-card space-y-3">
          <p className="text-xs text-muted-foreground">
            Without API keys, the tool uses deterministic demo data. Add keys for live listings.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Realty in US (RapidAPI)</label>
              <Input
                placeholder={hasRealty ? "Key saved ✓" : "Enter RapidAPI key"}
                value={realtyKey}
                onChange={(e) => setRealtyKey(e.target.value)}
                className="text-sm h-8"
                data-testid="input-realty-key"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">RentCast API</label>
              <Input
                placeholder={hasRentcast ? "Key saved ✓" : "Enter RentCast API key"}
                value={rentcastKey}
                onChange={(e) => setRentcastKey(e.target.value)}
                className="text-sm h-8"
                data-testid="input-rentcast-key"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || (!realtyKey.trim() && !rentcastKey.trim())}
            data-testid="button-save-keys"
          >
            <Key className="w-3.5 h-3.5 mr-1.5" />
            {saveMutation.isPending ? "Saving..." : "Save Keys"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ----- Search Panel -----

function SearchPanel({
  onSearch,
  isLoading,
}: {
  onSearch: (params: SearchParams) => void;
  isLoading: boolean;
}) {
  const [location, setLocation] = useState("");
  const [unitCount, setUnitCount] = useState<string>("any");
  const [bedrooms, setBedrooms] = useState<string>("any");
  const [bathrooms, setBathrooms] = useState<string>("any");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sortBy, setSortBy] = useState<string>("score");
  const [loanType, setLoanType] = useState<string>("fha");

  const handleSearch = useCallback(() => {
    if (!location.trim()) return;
    onSearch({
      location: location.trim(),
      unitCount: unitCount as any,
      bedrooms: bedrooms === "any" ? undefined : bedrooms,
      bathrooms: bathrooms === "any" ? undefined : bathrooms,
      minPrice: minPrice ? parseInt(minPrice, 10) : undefined,
      maxPrice: maxPrice ? parseInt(maxPrice, 10) : undefined,
      sortBy: sortBy as any,
      loanType: loanType as any,
    });
  }, [location, unitCount, bedrooms, bathrooms, minPrice, maxPrice, sortBy, loanType, onSearch]);

  return (
    <Card className="mb-6" data-testid="search-panel">
      <CardContent className="pt-5 pb-4 px-5">
        <div className="flex flex-col gap-3">
          {/* Row 1: Location + Search */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="City, ZIP, or State (e.g. Chicago, 60614, Oakland)"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="pl-8 h-9 text-sm"
                data-testid="input-location"
              />
            </div>
            <Button onClick={handleSearch} disabled={isLoading || !location.trim()} className="h-9 px-5" data-testid="button-search">
              {isLoading ? "Searching..." : "Search"}
            </Button>
          </div>
          {/* Row 2: Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Units</label>
              <Select value={unitCount} onValueChange={setUnitCount}>
                <SelectTrigger className="w-[80px] h-8 text-xs" data-testid="select-units"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="2">Duplex</SelectItem>
                  <SelectItem value="3">Triplex</SelectItem>
                  <SelectItem value="4">Fourplex</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Beds</label>
              <Select value={bedrooms} onValueChange={setBedrooms}>
                <SelectTrigger className="w-[70px] h-8 text-xs" data-testid="select-beds"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="2">2+</SelectItem>
                  <SelectItem value="3">3+</SelectItem>
                  <SelectItem value="4">4+</SelectItem>
                  <SelectItem value="6">6+</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Baths</label>
              <Select value={bathrooms} onValueChange={setBathrooms}>
                <SelectTrigger className="w-[70px] h-8 text-xs" data-testid="select-baths"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="2">2+</SelectItem>
                  <SelectItem value="3">3+</SelectItem>
                  <SelectItem value="4">4+</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Min $</label>
              <Input
                type="number" placeholder="0" value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                className="w-[90px] h-8 text-xs"
                data-testid="input-min-price"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Max $</label>
              <Input
                type="number" placeholder="Any" value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                className="w-[90px] h-8 text-xs"
                data-testid="input-max-price"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Loan</label>
              <Select value={loanType} onValueChange={setLoanType}>
                <SelectTrigger className="w-[145px] h-8 text-xs" data-testid="select-loan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fha">FHA 3.5% Down</SelectItem>
                  <SelectItem value="va_first">VA 1st Use (0%)</SelectItem>
                  <SelectItem value="va_subsequent">VA Repeat (0%)</SelectItem>
                  <SelectItem value="va_disabled">VA Disabled (0%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Sort</label>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[140px] h-8 text-xs" data-testid="select-sort"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="score">Best Score</SelectItem>
                  <SelectItem value="price_low">Price: Low</SelectItem>
                  <SelectItem value="price_high">Price: High</SelectItem>
                  <SelectItem value="offset_high">Offset: High</SelectItem>
                  <SelectItem value="cashflow_high">Cash Flow: High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ----- Market Stats Bar -----

function MarketStatsBar({ stats }: { stats: MarketStats }) {
  const items = [
    { label: "Listings", value: String(stats.totalListings) },
    { label: "Median Price", value: fmtCurrency(stats.medianPrice) },
    { label: "Median Rent", value: fmtCurrency(stats.medianRent) + "/mo" },
    { label: "Price / Unit", value: fmtCurrency(stats.medianPricePerUnit) },
    { label: "Avg Days", value: String(stats.avgDaysOnMarket) },
    { label: "Avg Offset", value: fmtPct(stats.avgMortgageOffset) },
  ];
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6" data-testid="market-stats">
      {items.map((item) => (
        <div key={item.label} className="bg-card border rounded-lg px-3 py-2.5 text-center">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{item.label}</div>
          <div className="text-sm font-semibold mt-0.5">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// ----- Score Bar Component -----

function ScoreBar({ score, max, label, Icon, color }: {
  score: number; max: number; label: string; Icon: any; color: string;
}) {
  const pct = Math.round((score / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="w-[100px] truncate text-muted-foreground">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-[38px] text-right font-medium tabular-nums">{score}/{max}</span>
    </div>
  );
}

// ----- Unit Breakdown -----

function UnitBreakdown({ units }: { units: UnitInfo[] }) {
  return (
    <div className="space-y-1.5">
      {units.map((unit) => (
        <div
          key={unit.unitLabel}
          className={`flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md ${
            unit.isOwnerUnit
              ? "bg-primary/8 border border-primary/20"
              : "bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`font-medium ${unit.isOwnerUnit ? "text-primary" : ""}`}>
              {unit.unitLabel}
            </span>
            {unit.isOwnerUnit && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-primary/30 text-primary">
                Owner
              </Badge>
            )}
            <span className="text-muted-foreground">
              {unit.bedrooms}bd / {unit.bathrooms}ba
              {unit.sqft ? ` · ${fmt(unit.sqft)} sqft` : ""}
            </span>
          </div>
          <span className={`font-semibold tabular-nums ${unit.isOwnerUnit ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400"}`}>
            {unit.estimatedRent ? fmtCurrency(unit.estimatedRent) + "/mo" : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ----- Rent Control Badge -----

const RENT_CONTROL_COLORS: Record<RentControlStatus, { badge: string; dot: string }> = {
  none: {
    badge: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
    dot: "bg-emerald-500",
  },
  state_cap: {
    badge: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
    dot: "bg-amber-500",
  },
  local_control: {
    badge: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
    dot: "bg-red-500",
  },
  exempt_owner_occupied: {
    badge: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-800",
    dot: "bg-teal-500",
  },
};

function RentControlBadge({ listing }: { listing: HouseHackListing }) {
  const status = listing.rentControlStatus;
  const colors = RENT_CONTROL_COLORS[status];
  const label = RENT_CONTROL_LABELS[status];

  const tooltipLines: string[] = [];
  if (listing.rentControlNotes) tooltipLines.push(listing.rentControlNotes);
  if (listing.rentControlMaxIncrease !== null) {
    tooltipLines.push(`Max annual increase: ${listing.rentControlMaxIncrease}%`);
  }
  if (listing.ownerOccupiedExempt) {
    tooltipLines.push("Owner-occupied duplexes are exempt from rent caps in this jurisdiction.");
  }

  const IconComponent = status === "none" ? ShieldCheck
    : status === "exempt_owner_occupied" ? Shield
    : status === "state_cap" ? ShieldAlert
    : ShieldX;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 h-5 rounded-full border cursor-default ${colors.badge}`}
          data-testid={`rent-control-badge-${listing.id}`}
        >
          <IconComponent className="w-3 h-3" />
          <span className="font-medium">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs">
        <p className="font-semibold mb-1 flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
          {label} — {listing.city}, {listing.state}
        </p>
        {tooltipLines.length > 0 ? (
          <div className="space-y-1">
            {tooltipLines.map((line, i) => (
              <p key={i} className="text-muted-foreground">{line}</p>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">No rent control restrictions apply to this property.</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ----- Feature Badges -----

function FeatureBadges({ listing }: { listing: HouseHackListing }) {
  const badges: { label: string; variant: "default" | "secondary" | "outline"; icon?: any }[] = [];

  // Parking
  if (listing.parkingType !== "unknown") {
    badges.push({
      label: PARKING_LABELS[listing.parkingType],
      variant: listing.parkingType.includes("garage") ? "default" : "secondary",
      icon: Car,
    });
  }

  // Yard
  const yardParts: string[] = [];
  if (listing.hasPrivateYard) yardParts.push("Private");
  if (listing.hasFrontYard) yardParts.push("Front");
  if (listing.hasSideYard) yardParts.push("Side");
  if (listing.hasFencedYard) yardParts.push("Fenced");
  if (yardParts.length > 0) {
    badges.push({ label: yardParts.join(", ") + " Yard", variant: "secondary", icon: TreePine });
  }

  // Schools
  if (listing.avgSchoolRating !== null) {
    const schoolVariant = listing.avgSchoolRating >= 7 ? "default" as const : "secondary" as const;
    badges.push({ label: `Schools: ${listing.avgSchoolRating}/10`, variant: schoolVariant, icon: GraduationCap });
  }

  // Flood
  if (listing.floodFactorScore !== null) {
    const floodVariant = listing.floodFactorScore <= 3 ? "secondary" as const : "outline" as const;
    badges.push({ label: `Flood: ${listing.floodFactorScore}/10`, variant: floodVariant, icon: Droplets });
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map((b, i) => (
        <Badge key={i} variant={b.variant} className="text-[10px] px-2 py-0.5 h-5 gap-1 font-normal">
          {b.icon && <b.icon className="w-3 h-3" />}
          {b.label}
        </Badge>
      ))}
      <RentControlBadge listing={listing} />
      {listing.negotiationSignals.length > 0 && (
        <NegotiationBadge signals={listing.negotiationSignals} />
      )}
    </div>
  );
}

// ----- Negotiation Badge -----

function NegotiationBadge({ signals }: { signals: NegotiationSignal[] }) {
  const strongCount = signals.filter(s => s.strength === "strong").length;
  const moderateCount = signals.filter(s => s.strength === "moderate").length;

  if (strongCount === 0 && moderateCount === 0) return null;

  const color = strongCount > 0
    ? "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800"
    : "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800";
  const total = strongCount + moderateCount;
  const label = strongCount > 0 ? `${total} Negotiation Signal${total > 1 ? "s" : ""}` : `${moderateCount} Signal${moderateCount > 1 ? "s" : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 h-5 rounded-full border cursor-default ${color}`}>
          <Handshake className="w-3 h-3" />
          <span className="font-medium">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs">
        <p className="font-semibold mb-1">Negotiation Leverage</p>
        {strongCount > 0 && <p className="text-emerald-600 dark:text-emerald-400">{strongCount} strong signal{strongCount > 1 ? "s" : ""}</p>}
        {moderateCount > 0 && <p className="text-blue-600 dark:text-blue-400">{moderateCount} moderate signal{moderateCount > 1 ? "s" : ""}</p>}
        <p className="text-muted-foreground mt-1">Expand for full negotiation intel.</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ----- Negotiation Intel Section -----

function NegotiationIntel({ listing }: { listing: HouseHackListing }) {
  const signals = listing.negotiationSignals;
  if (signals.length === 0) return null;

  const strongSignals = signals.filter(s => s.strength === "strong");
  const moderateSignals = signals.filter(s => s.strength === "moderate");
  const infoSignals = signals.filter(s => s.strength === "info");

  const STRENGTH_ICON: Record<NegotiationStrength, any> = {
    strong: Zap,
    moderate: Clock,
    info: Info,
  };

  const STRENGTH_LABEL: Record<NegotiationStrength, string> = {
    strong: "Strong Leverage",
    moderate: "Moderate Leverage",
    info: "Context",
  };

  const renderGroup = (group: NegotiationSignal[], strength: NegotiationStrength) => {
    if (group.length === 0) return null;
    const Icon = STRENGTH_ICON[strength];
    return (
      <div className="space-y-1.5">
        <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide ${SIGNAL_COLORS[strength]}`}>
          <Icon className="w-3 h-3" />
          {STRENGTH_LABEL[strength]}
        </div>
        {group.map((signal, i) => (
          <div key={i} className={`rounded-md border px-3 py-2 ${SIGNAL_BG[strength]}`}>
            <div className={`text-xs font-semibold mb-0.5 ${SIGNAL_COLORS[strength]}`}>{signal.label}</div>
            <div className="text-xs text-muted-foreground leading-relaxed">{signal.detail}</div>
          </div>
        ))}
      </div>
    );
  };

  // Summary line
  const totalLeverage = strongSignals.length * 2 + moderateSignals.length;
  const summaryText = totalLeverage >= 4 ? "Strong negotiation position — multiple factors favor the buyer."
    : totalLeverage >= 2 ? "Moderate leverage available — some room to negotiate."
    : "Limited leverage signals — focus on terms rather than price.";

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Handshake className="w-3.5 h-3.5" />
        Negotiation Intel
      </h4>
      <p className="text-xs text-muted-foreground mb-2.5">{summaryText}</p>
      <div className="space-y-3">
        {renderGroup(strongSignals, "strong")}
        {renderGroup(moderateSignals, "moderate")}
        {renderGroup(infoSignals, "info")}
      </div>
      {/* Price metrics bar */}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-3 pt-2 border-t border-dashed text-[10px] text-muted-foreground">
        {listing.pricePerSqft !== null && <span>Price/sqft: {fmtCurrency(listing.pricePerSqft)}</span>}
        <span>Price/unit: {fmtCurrency(listing.pricePerUnit)}</span>
        {listing.estimatedValue !== null && <span>Est. value: {fmtCurrency(listing.estimatedValue)}</span>}
        {listing.valueGapPercent !== null && (
          <span className={listing.valueGapPercent > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
            {listing.valueGapPercent > 0 ? "+" : ""}{fmtPct(listing.valueGapPercent)} vs est.
          </span>
        )}
      </div>
    </div>
  );
}

// ----- Listing Card -----

function ListingCard({ listing }: { listing: HouseHackListing }) {
  const [expanded, setExpanded] = useState(false);
  const scoreColor = SCORE_COLORS[listing.scoreLabel] || "";
  const scoreBg = SCORE_BG[listing.scoreLabel] || "";

  const offsetPositive = listing.mortgageOffsetPercent !== null && listing.mortgageOffsetPercent >= 100;
  const ownerFree = listing.ownerNetMonthlyCost !== null && listing.ownerNetMonthlyCost <= 0;

  return (
    <Card className="overflow-hidden hover-elevate transition-all duration-200" data-testid={`card-listing-${listing.id}`}>
      <CardContent className="p-0">
        {/* Top Row: Score + Address + Price */}
        <div className="flex items-start gap-3 p-4 pb-3">
          {/* Score Circle */}
          <div className="shrink-0 flex flex-col items-center">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center border-2 ${
              listing.dealScore >= 80 ? "border-emerald-500" :
              listing.dealScore >= 65 ? "border-blue-500" :
              listing.dealScore >= 50 ? "border-amber-500" :
              listing.dealScore >= 35 ? "border-orange-500" : "border-red-400"
            }`}>
              <span className={`text-lg font-bold ${scoreColor}`}>{listing.dealScore}</span>
            </div>
            <span className={`text-[10px] font-medium mt-1 ${scoreColor}`}>{listing.scoreLabel}</span>
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold truncate">{listing.address}</h3>
                <p className="text-xs text-muted-foreground">
                  {listing.city}, {listing.state} {listing.zipCode}
                  {listing.daysOnMarket !== null && ` · ${listing.daysOnMarket}d on market`}
                </p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-base font-bold">{fmtCurrency(listing.price)}</div>
                {listing.totalPriceReduction !== null && listing.totalPriceReduction > 0 && (
                  <div className="flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 justify-end">
                    <TrendingDown className="w-3 h-3" />
                    <span>-{fmtCurrency(listing.totalPriceReduction)} ({fmtPct(listing.totalReductionPercent)})</span>
                  </div>
                )}
              </div>
            </div>

            {/* Property Quick Stats */}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-xs text-muted-foreground">
              <span>{listing.unitCount}-unit</span>
              <span>{listing.totalBedrooms}bd / {listing.totalBathrooms}ba</span>
              {listing.totalSqft && <span>{fmt(listing.totalSqft)} sqft</span>}
              {listing.yearBuilt && <span>Built {listing.yearBuilt}</span>}
              {listing.lotSizeSqft && <span>{fmt(listing.lotSizeSqft)} sqft lot</span>}
            </div>
          </div>
        </div>

        {/* Financial Highlights */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border mx-4">
          <FinancialCell
            label="PITI Offset"
            value={fmtPct(listing.mortgageOffsetPercent)}
            positive={offsetPositive}
            sublabel={listing.rentalUnitIncome ? `${fmtCurrency(listing.rentalUnitIncome)}/mo rent` : undefined}
          />
          <FinancialCell
            label="Owner Cost"
            value={listing.ownerNetMonthlyCost !== null ? fmtCurrency(listing.ownerNetMonthlyCost) + "/mo" : "N/A"}
            positive={ownerFree}
            sublabel={ownerFree ? "Free living!" : undefined}
          />
          <FinancialCell
            label="Monthly Cash Flow"
            value={listing.monthlyCashFlow !== null ? fmtCurrency(listing.monthlyCashFlow) + "/mo" : "N/A"}
            positive={listing.monthlyCashFlow !== null && listing.monthlyCashFlow > 0}
            sublabel={listing.annualCashFlow !== null ? `${fmtCurrency(listing.annualCashFlow)}/yr` : undefined}
          />
          <FinancialCell
            label="Cash-on-Cash"
            value={fmtPct(listing.cashOnCashReturn)}
            positive={listing.cashOnCashReturn !== null && listing.cashOnCashReturn > 0}
            sublabel={listing.capRate !== null ? `Cap: ${fmtPct(listing.capRate)}` : undefined}
          />
        </div>

        {/* Feature Badges */}
        <div className="px-4 pt-3 pb-2">
          <FeatureBadges listing={listing} />
        </div>

        {/* Expand / Collapse */}
        <div className="px-4 pb-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
            data-testid={`toggle-details-${listing.id}`}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {expanded ? "Hide details" : "Show details, scores & negotiation intel"}
          </button>
        </div>

        {/* Expanded Details */}
        {expanded && (
          <div className="border-t px-4 py-4 space-y-4 bg-muted/20">
            {/* Unit Breakdown */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Unit Breakdown</h4>
              <UnitBreakdown units={listing.units} />
              {listing.totalEstimatedRent !== null && (
                <div className="flex justify-between text-xs mt-2 pt-2 border-t border-dashed">
                  <span className="text-muted-foreground">Total Rent (all units)</span>
                  <span className="font-semibold">{fmtCurrency(listing.totalEstimatedRent)}/mo</span>
                </div>
              )}
              <div className="flex justify-between text-xs mt-1">
                <span className="text-muted-foreground">Monthly PITI</span>
                <span className="font-semibold">{fmtCurrency(listing.monthlyPITI)}/mo</span>
              </div>
            </div>

            {/* Score Breakdown */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Score Breakdown — {listing.dealScore}/100
              </h4>
              <div className="space-y-1.5">
                {(Object.keys(DIMENSION_INFO) as (keyof ScoreBreakdown)[]).map((key) => {
                  const dim = DIMENSION_INFO[key];
                  return (
                    <ScoreBar
                      key={key}
                      score={listing.scoreBreakdown[key]}
                      max={dim.max}
                      label={dim.label}
                      Icon={dim.icon}
                      color={dim.color}
                    />
                  );
                })}
              </div>
            </div>

            {/* Cash Flow Analysis */}
            {listing.annualGrossRent !== null && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Cash Flow Analysis</h4>
                <div className="space-y-0.5">
                  <CashFlowRow label="Gross Rental Income" value={fmtCurrency(listing.annualGrossRent)} sublabel="/yr" />
                  <CashFlowRow label={`Vacancy (${Math.round(listing.vacancyRate * 100)}%)`} value={`-${fmtCurrency(listing.annualVacancyLoss)}`} sublabel="/yr" negative />
                  <CashFlowRow label="Effective Gross Income" value={fmtCurrency(listing.effectiveGrossIncome)} sublabel="/yr" bold />
                  <CashFlowRow label={`Operating Expenses (${Math.round(listing.expenseRate * 100)}%)`} value={`-${fmtCurrency(listing.annualOperatingExpenses)}`} sublabel="/yr" negative />
                  <div className="border-t border-dashed my-1" />
                  <CashFlowRow label="Net Operating Income (NOI)" value={fmtCurrency(listing.netOperatingIncome)} sublabel="/yr" bold />
                  <CashFlowRow label="Annual Debt Service" value={`-${fmtCurrency(listing.monthlyPITI * 12)}`} sublabel="/yr" negative />
                  <div className="border-t my-1" />
                  <div className="flex items-center justify-between text-xs px-2 py-1.5 rounded-md bg-primary/5 border border-primary/15">
                    <span className="font-semibold">Annual Cash Flow</span>
                    <span className={`font-bold tabular-nums ${listing.annualCashFlow !== null && listing.annualCashFlow >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                      {fmtCurrency(listing.annualCashFlow)}/yr
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs px-2 py-1.5 rounded-md bg-primary/5 border border-primary/15">
                    <span className="font-semibold">Monthly Cash Flow</span>
                    <span className={`font-bold tabular-nums ${listing.monthlyCashFlow !== null && listing.monthlyCashFlow >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                      {fmtCurrency(listing.monthlyCashFlow)}/mo
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-[10px] text-muted-foreground">
                  <span>Cap Rate: {fmtPct(listing.capRate)}</span>
                  <span>CoC Return: {fmtPct(listing.cashOnCashReturn)}</span>
                  {listing.grossRentMultiplier && <span>GRM: {listing.grossRentMultiplier}</span>}
                  <span>Cash Invested: {fmtCurrency(listing.totalCashInvested)}</span>
                </div>
              </div>
            )}

            {/* Loan Details */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Loan Details</h4>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Loan Type</span>
                  <span className="font-medium">{LOAN_LABELS[listing.loanType]}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Down Payment</span>
                  <span className="font-medium">{Number(listing.downPaymentPercent.toFixed(1))}% ({fmtCurrency(Math.round(listing.price * listing.downPaymentPercent / 100))})</span>
                </div>
                {listing.fundingFeePercent > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">VA Funding Fee</span>
                    <span className="font-medium">{listing.fundingFeePercent}% (rolled into loan)</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Total Cash Needed</span>
                  <span className="font-semibold text-primary">{fmtCurrency(listing.totalCashInvested)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Monthly PITI</span>
                  <span className="font-medium">{fmtCurrency(listing.monthlyPITI)}/mo</span>
                </div>
                {listing.loanType.startsWith("va") && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">PMI</span>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">None (VA benefit)</span>
                  </div>
                )}
              </div>
            </div>

            {/* Rent Control Details */}
            {listing.rentControlStatus !== "none" && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Rent Regulation</h4>
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${RENT_CONTROL_COLORS[listing.rentControlStatus].dot}`} />
                    <span className="font-medium">{RENT_CONTROL_LABELS[listing.rentControlStatus]}</span>
                  </div>
                  {listing.rentControlMaxIncrease !== null && (
                    <p className="text-muted-foreground ml-3.5">Max annual increase: {listing.rentControlMaxIncrease}%</p>
                  )}
                  {listing.rentControlNotes && (
                    <p className="text-muted-foreground ml-3.5">{listing.rentControlNotes}</p>
                  )}
                  {listing.ownerOccupiedExempt && (
                    <p className="text-emerald-600 dark:text-emerald-400 ml-3.5 font-medium">
                      Owner-occupied duplex exempt from rent caps
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Negotiation Intel */}
            <NegotiationIntel listing={listing} />

            {/* Price History */}
            {listing.priceReductions.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Price History</h4>
                <div className="space-y-1">
                  {listing.originalListPrice && (
                    <div className="text-xs text-muted-foreground">
                      Original list: {fmtCurrency(listing.originalListPrice)}
                    </div>
                  )}
                  {listing.priceReductions.map((pr, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <TrendingDown className="w-3 h-3 text-emerald-500 shrink-0" />
                      <span className="text-muted-foreground">{pr.date}</span>
                      <span>{fmtCurrency(pr.previousPrice)} → {fmtCurrency(pr.newPrice)}</span>
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        -{fmtPct(pr.dropPercent)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Schools */}
            {listing.schools.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Nearby Schools</h4>
                <div className="space-y-1">
                  {listing.schools.map((s, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{s.name} ({s.level})</span>
                      <span className="flex items-center gap-2">
                        <span>{s.distanceMiles.toFixed(1)}mi</span>
                        {s.rating !== null && (
                          <Badge variant={s.rating >= 7 ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">
                            {s.rating}/10
                          </Badge>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Listing Link */}
            {listing.listingUrl && (
              <a
                href={listing.listingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                View on {listing.source} <ArrowUpRight className="w-3 h-3" />
              </a>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FinancialCell({
  label, value, positive, sublabel,
}: {
  label: string; value: string; positive?: boolean; sublabel?: string;
}) {
  return (
    <div className="bg-card px-3 py-2 text-center">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-bold mt-0.5 tabular-nums ${positive ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
        {value}
      </div>
      {sublabel && <div className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</div>}
    </div>
  );
}

function CashFlowRow({ label, value, sublabel, negative, bold }: {
  label: string; value: string; sublabel?: string; negative?: boolean; bold?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between text-xs px-2 py-1 ${bold ? "font-medium" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${negative ? "text-red-600 dark:text-red-400" : ""} ${bold ? "font-semibold" : ""}`}>
        {value}{sublabel && <span className="text-muted-foreground">{sublabel}</span>}
      </span>
    </div>
  );
}

// ----- Loading Skeleton -----

function ListingSkeleton() {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex gap-3">
          <Skeleton className="w-14 h-14 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="w-20 h-6" />
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </CardContent>
    </Card>
  );
}

// ----- Main Page -----

export default function HomePage() {
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [isDark, setIsDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  const searchMutation = useMutation({
    mutationFn: async (params: SearchParams) => {
      const res = await apiRequest("POST", "/api/search", params);
      return (await res.json()) as SearchResult;
    },
    onSuccess: (data) => {
      setSearchResult(data);
    },
    onError: (err: any) => {
      console.error("Search failed:", err);
    },
  });

  const handleSearch = useCallback((params: SearchParams) => {
    searchMutation.mutate(params);
  }, [searchMutation]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <svg
              viewBox="0 0 32 32"
              className="w-7 h-7 text-primary"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-label="HouseHackScore logo"
            >
              <path d="M4 16L16 4l12 12" />
              <path d="M6 14v14h8V20h4v8h8V14" />
              <line x1="16" y1="20" x2="16" y2="28" />
            </svg>
            <div>
              <h1 className="text-base font-bold leading-tight">HouseHackScore</h1>
              <p className="text-[11px] text-muted-foreground leading-tight">Multi-family investment scoring</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded" data-testid="button-info">
                  <Info className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[320px] text-xs">
                <p className="font-semibold mb-1">100-Point Scoring System</p>
                <p>Mortgage Offset (20), Owner Cost (15), Cash-on-Cash (10), Building Age (10), Unit Config (10), Parking (8), Schools (8), Lot Size (5), Yard (5), Price Cuts (5), Flood (4).</p>
                <p className="mt-1.5 font-medium">Loan Options</p>
                <p>FHA: 3.5% down, 6.5% rate, MIP included.</p>
                <p>VA: 0% down, 6.25% rate, no PMI. Funding fee rolled into loan (2.15% 1st use, 3.3% subsequent, 0% disabled vets).</p>
                <p className="mt-1.5 font-medium">Cash Flow</p>
                <p>8% vacancy rate. Expenses: 35% (newer) / 45% (older buildings). Cash flow = EGI - expenses - debt service.</p>
                <p className="mt-1.5 font-medium">Rent Control</p>
                <p>Badges show local/state rent caps. Owner-occupied duplexes may be exempt (e.g., CA AB 1482). Hover badges for details.</p>
                <p className="mt-1.5 font-medium">Negotiation Intel</p>
                <p>Each listing is analyzed for leverage signals: days on market, price cuts, value gaps, and building age. Green = strong, blue = moderate.</p>
                <p className="mt-1.5 font-medium">Export</p>
                <p>Download results as CSV for spreadsheets and sharing.</p>
              </TooltipContent>
            </Tooltip>
            <button
              onClick={() => setIsDark(!isDark)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded"
              data-testid="button-theme-toggle"
            >
              {isDark ? "Light" : "Dark"}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-5">
        <ApiConfigPanel />
        <SearchPanel onSearch={handleSearch} isLoading={searchMutation.isPending} />

        {/* Results */}
        {searchMutation.isPending && (
          <div className="space-y-4" data-testid="loading-state">
            <ListingSkeleton />
            <ListingSkeleton />
            <ListingSkeleton />
          </div>
        )}

        {searchMutation.isError && (
          <div className="flex items-center gap-2 p-4 rounded-lg border border-destructive/20 bg-destructive/5 text-sm" data-testid="error-state">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
            <span>Search failed. Check your API keys or try a different location.</span>
          </div>
        )}

        {searchResult && !searchMutation.isPending && (
          <>
            <MarketStatsBar stats={searchResult.marketStats} />
            {searchResult.listings.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground" data-testid="empty-state">
                <Building2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm">No multi-family listings found for this search.</p>
                <p className="text-xs mt-1">Try a different location or adjust your filters.</p>
              </div>
            ) : (
              <div className="space-y-4" data-testid="listings-container">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    {searchResult.listings.length} listing{searchResult.listings.length !== 1 ? "s" : ""} · Sorted by {searchResult.searchParams.sortBy || "score"}
                    {searchResult.listings[0]?.source === "Demo Data" && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">(Demo Data)</span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    data-testid="button-export-csv"
                    onClick={async () => {
                      try {
                        const res = await apiRequest("POST", "/api/export/csv", searchResult.searchParams);
                        const blob = await res.blob();
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `househackscore-${searchResult.searchParams.location.replace(/[^a-zA-Z0-9]/g, "_")}.csv`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        window.URL.revokeObjectURL(url);
                      } catch (err) {
                        console.error("Export failed:", err);
                      }
                    }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV
                  </Button>
                </div>
                {searchResult.listings.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty Initial State */}
        {!searchResult && !searchMutation.isPending && !searchMutation.isError && (
          <div className="text-center py-16" data-testid="initial-state">
            <Building2 className="w-12 h-12 mx-auto mb-4 text-primary/30" />
            <h2 className="text-base font-semibold mb-1">Find Your House Hack</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Search for duplexes, triplexes, and fourplexes. Each property gets scored on 11 dimensions including mortgage offset, cash flow, schools, parking, and more.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-4">
              {["Chicago", "Oakland", "Philadelphia", "Atlanta", "Denver", "Austin"].map(city => (
                <button
                  key={city}
                  onClick={() => {
                    const input = document.querySelector<HTMLInputElement>('[data-testid="input-location"]');
                    if (input) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                      )?.set;
                      nativeInputValueSetter?.call(input, city);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                  }}
                  className="text-xs px-3 py-1.5 rounded-full border hover:bg-muted transition-colors"
                  data-testid={`quicklink-${city.toLowerCase()}`}
                >
                  {city}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t mt-12 py-4 text-center text-xs text-muted-foreground">
        <p className="mb-1">
          FHA 3.5% / VA 0% down · 30yr fixed · 8% vacancy · Expenses 35%/45% · Rent control · Negotiation intel · CSV export · Deterministic
        </p>
        <PerplexityAttribution />
      </footer>
    </div>
  );
}
