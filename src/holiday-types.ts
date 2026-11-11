/** Downloaded China mainland public holidays and compensatory workdays. */
export interface HolidayYearData {
  year: number;
  papers: string[];
  days: { date: string; name: string; isOffDay: boolean }[];
  fetchedAt: number;
  source: string;
}

export interface HolidayState {
  status: "idle" | "refreshing" | "ready" | "error";
  years: HolidayYearData[];
  lastChecked: number | null;
  message: string;
  systemProxy: true;
}
