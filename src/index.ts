import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

const CWA_API_BASE = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";
const CWA_API_KEY = process.env.CWA_API_KEY;

const TW_COUNTIES = [
    "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
    "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣",
    "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣",
    "臺東縣", "澎湖縣", "金門縣", "連江縣",
] as const;

// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/geo+json",
    };

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json()) as T;
    } catch (error) {
        console.error("Error making NWS request:", error);
        return null;
    }
}

// Helper function for making CWA (Taiwan) open data requests
async function makeCWARequest<T>(
    dataId: string,
    params: Record<string, string> = {},
): Promise<T | null> {
    if (!CWA_API_KEY) {
        throw new Error(
            "CWA_API_KEY environment variable is not set. Get a free key at https://opendata.cwa.gov.tw/ and set it before running this server.",
        );
    }

    const url = new URL(`${CWA_API_BASE}/${dataId}`);
    url.searchParams.set("Authorization", CWA_API_KEY);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json()) as T;
    } catch (error) {
        console.error("Error making CWA request:", error);
        return null;
    }
}

interface AlertFeature {
    properties: {
        event?: string;
        areaDesc?: string;
        severity?: string;
        description?: string;
        instruction?: string;
    };
}

interface ForecastPeriod {
    name?: string;
    temperature?: number;
    temperatureUnit?: string;
    windSpeed?: string;
    windDirection?: string;
    detailedForecast?: string;
}

interface AlertsResponse {
    features: AlertFeature[];
}

interface PointsResponse {
    properties: {
        forecast?: string;
    };
}

interface ForecastResponse {
    properties: {
        periods: ForecastPeriod[];
    };
}

interface CWAWeatherElementTime {
    startTime: string;
    endTime: string;
    parameter: { parameterName: string; parameterUnit?: string };
}

interface CWAWeatherElement {
    elementName: string;
    time: CWAWeatherElementTime[];
}

interface CWAForecastResponse {
    records: {
        location: {
            locationName: string;
            weatherElement: CWAWeatherElement[];
        }[];
    };
}

interface CWAHazard {
    info?: { phenomena?: string; significance?: string };
    phenomena?: string;
    significance?: string;
    validTime?: { startTime?: string; endTime?: string };
    startTime?: string;
    endTime?: string;
}

interface CWAAlertsResponse {
    records: {
        location: {
            locationName: string;
            hazardConditions: { hazards: CWAHazard[] };
        }[];
    };
}

/**
 * The output schema of `get-alerts`: a top-level array, not an object, which
 * revision 2026-07-28 is the first to allow. The SDK projects it down to the
 * old `{ result: [...] }` wrapper for 2025-11-25 clients.
 */
const alertsOutputSchema = z.array(
    z.object({
        event: z.string().describe("The kind of weather event"),
        area: z.string().describe("The area the alert covers"),
        severity: z.string().describe("How severe the event is"),
        description: z.string().describe("What is happening"),
        instructions: z.string().describe("What people in the area should do"),
    }),
);

/** The output schema of `get-forecast`: the object case. */
const forecastOutputSchema = z.object({
    latitude: z.number().describe("Latitude the forecast is for"),
    longitude: z.number().describe("Longitude the forecast is for"),
    periods: z
        .array(
            z.object({
                name: z.string(),
                temperature: z.number().nullable(),
                temperature_unit: z.string(),
                wind_speed: z.string(),
                wind_direction: z.string(),
                detailed_forecast: z.string(),
            }),
        )
        .describe("The forecast periods, soonest first"),
});

/** The output schema of `get-tw-forecast`. */
const twForecastOutputSchema = z.object({
    county: z.string().describe("The Taiwan county/city the forecast is for"),
    periods: z
        .array(
            z.object({
                start_time: z.string(),
                end_time: z.string(),
                weather: z.string().describe("Weather phenomenon description"),
                rain_probability: z.string().describe("Probability of precipitation (%)"),
                min_temperature: z.string().describe("Minimum temperature (°C)"),
                max_temperature: z.string().describe("Maximum temperature (°C)"),
                comfort: z.string().describe("Comfort index description"),
            }),
        )
        .describe("The forecast periods, soonest first"),
});

/** The output schema of `get-tw-alerts`: a top-level array, matching `get-alerts`. */
const twAlertsOutputSchema = z.array(
    z.object({
        county: z.string().describe("The county/city the alert covers"),
        phenomena: z.string().describe("The kind of weather hazard"),
        significance: z.string().describe("The severity/type of the notice"),
        start_time: z.string(),
        end_time: z.string(),
    }),
);

type Alert = z.infer<typeof alertsOutputSchema>[number];
type Forecast = z.infer<typeof forecastOutputSchema>;
type TWForecast = z.infer<typeof twForecastOutputSchema>;
type TWAlert = z.infer<typeof twAlertsOutputSchema>[number];

// Format alert data for the model to read
function formatAlert(alert: Alert): string {
    return [
        `Event: ${alert.event}`,
        `Area: ${alert.area}`,
        `Severity: ${alert.severity}`,
        `Description: ${alert.description}`,
        `Instructions: ${alert.instructions}`,
        "---",
    ].join("\n");
}

function formatPeriod(period: Forecast["periods"][number]): string {
    return [
        `${period.name}:`,
        period.temperature === null
            ? "Temperature: Unknown"
            : `Temperature: ${period.temperature}°${period.temperature_unit}`,
        `Wind: ${period.wind_speed} ${period.wind_direction}`,
        period.detailed_forecast,
        "---",
    ].join("\n");
}

function formatTWPeriod(period: TWForecast["periods"][number]): string {
    return [
        `${period.start_time} ~ ${period.end_time}:`,
        `Weather: ${period.weather}`,
        `Rain probability: ${period.rain_probability}%`,
        `Temperature: ${period.min_temperature}°C ~ ${period.max_temperature}°C`,
        `Comfort: ${period.comfort}`,
        "---",
    ].join("\n");
}

function formatTWAlert(alert: TWAlert): string {
    return [
        `County: ${alert.county}`,
        `Phenomena: ${alert.phenomena}`,
        `Significance: ${alert.significance}`,
        `Valid: ${alert.start_time} ~ ${alert.end_time}`,
        "---",
    ].join("\n");
}

function buildServer(): McpServer {
    const server = new McpServer({
        name: "weather",
        version: "1.0.0",
    });

    server.registerTool(
        "get-alerts",
        {
            title: "Get Weather Alerts",
            description: "Get weather alerts for a state",
            inputSchema: z.object({
                state: z
                    .string()
                    .length(2)
                    .describe("Two-letter state code (e.g. CA, NY)"),
            }),
            outputSchema: alertsOutputSchema,
        },
        async ({ state }) => {
            const stateCode = state.toUpperCase();
            const alertsUrl = `${NWS_API_BASE}/alerts/active/area/${stateCode}`;
            const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

            if (!alertsData) {
                throw new Error(`Failed to retrieve alerts data for ${stateCode}`);
            }

            // An empty result is an empty array, not an error.
            // `??` catches the nulls NWS sends for these fields; it does not omit
            // them, so a key-missing default would not fire.
            const alerts: Alert[] = (alertsData.features ?? []).map((feature) => ({
                event: feature.properties.event ?? "Unknown",
                area: feature.properties.areaDesc ?? "Unknown",
                severity: feature.properties.severity ?? "Unknown",
                description: feature.properties.description ?? "No description available",
                instructions:
                    feature.properties.instruction ?? "No specific instructions provided",
            }));

            const text =
                alerts.length === 0
                    ? `No active alerts for ${stateCode}`
                    : `Active alerts for ${stateCode}:\n\n${alerts.map(formatAlert).join("\n")}`;

            return { content: [{ type: "text", text }], structuredContent: alerts };
        },
    );

    server.registerTool(
        "get-forecast",
        {
            title: "Get Weather Forecast",
            description: "Get weather forecast for a location",
            inputSchema: z.object({
                latitude: z
                    .number()
                    .min(-90)
                    .max(90)
                    .describe("Latitude of the location"),
                longitude: z
                    .number()
                    .min(-180)
                    .max(180)
                    .describe("Longitude of the location"),
            }),
            outputSchema: forecastOutputSchema,
        },
        async ({ latitude, longitude }) => {
            // Get grid point data
            const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
            const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

            if (!pointsData) {
                throw new Error(
                    `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                );
            }

            const forecastUrl = pointsData.properties?.forecast;
            if (!forecastUrl) {
                throw new Error("Failed to get forecast URL from grid point data");
            }

            // Get forecast data
            const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
            if (!forecastData) {
                throw new Error("Failed to retrieve forecast data");
            }

            const rawPeriods = forecastData.properties?.periods ?? [];
            if (rawPeriods.length === 0) {
                throw new Error("No forecast periods available");
            }

            const forecast: Forecast = {
                latitude,
                longitude,
                // Only show the next 5 periods.
                periods: rawPeriods.slice(0, 5).map((period) => ({
                    name: period.name ?? "Unknown",
                    temperature: period.temperature ?? null,
                    temperature_unit: period.temperatureUnit ?? "F",
                    wind_speed: period.windSpeed ?? "Unknown",
                    wind_direction: period.windDirection ?? "Unknown",
                    detailed_forecast: period.detailedForecast ?? "No forecast available",
                })),
            };

            const text = `Forecast for ${latitude}, ${longitude}:\n\n${forecast.periods
                .map(formatPeriod)
                .join("\n")}`;

            return { content: [{ type: "text", text }], structuredContent: forecast };
        },
    );

    server.registerTool(
        "get-tw-forecast",
        {
            title: "Get Taiwan Weather Forecast",
            description: "Get the 36-hour weather forecast for a Taiwan county/city",
            inputSchema: z.object({
                county: z
                    .enum(TW_COUNTIES)
                    .describe("Taiwan county/city name, e.g. 臺北市, 高雄市"),
            }),
            outputSchema: twForecastOutputSchema,
        },
        async ({ county }) => {
            const data = await makeCWARequest<CWAForecastResponse>("F-C0032-001", {
                locationName: county,
            });

            if (!data) {
                throw new Error(`Failed to retrieve forecast data for ${county}`);
            }

            const location = data.records.location[0];
            if (!location) {
                throw new Error(`No forecast data found for ${county}`);
            }

            // The elements share identical time boundaries by index, so they
            // can be zipped together using Wx's periods as the base.
            const elements = new Map(location.weatherElement.map((el) => [el.elementName, el.time]));
            const wxTimes = elements.get("Wx") ?? [];

            const periods = wxTimes.map((wx, i) => ({
                start_time: wx.startTime,
                end_time: wx.endTime,
                weather: wx.parameter.parameterName,
                rain_probability: elements.get("PoP")?.[i]?.parameter.parameterName ?? "Unknown",
                min_temperature: elements.get("MinT")?.[i]?.parameter.parameterName ?? "Unknown",
                max_temperature: elements.get("MaxT")?.[i]?.parameter.parameterName ?? "Unknown",
                comfort: elements.get("CI")?.[i]?.parameter.parameterName ?? "Unknown",
            }));

            if (periods.length === 0) {
                throw new Error(`No forecast periods available for ${county}`);
            }

            const forecast: TWForecast = { county, periods };
            const text = `Forecast for ${county}:\n\n${periods.map(formatTWPeriod).join("\n")}`;

            return { content: [{ type: "text", text }], structuredContent: forecast };
        },
    );

    server.registerTool(
        "get-tw-alerts",
        {
            title: "Get Taiwan Weather Alerts",
            description:
                "Get active weather alerts (特報) for a Taiwan county/city, or all counties if omitted",
            inputSchema: z.object({
                county: z
                    .enum(TW_COUNTIES)
                    .optional()
                    .describe("Taiwan county/city name; omit for all counties"),
            }),
            outputSchema: twAlertsOutputSchema,
        },
        async ({ county }) => {
            const data = await makeCWARequest<CWAAlertsResponse>(
                "W-C0033-001",
                county ? { locationName: county } : {},
            );

            if (!data) {
                throw new Error("Failed to retrieve Taiwan weather alerts");
            }

            const alerts: TWAlert[] = data.records.location.flatMap((loc) =>
                loc.hazardConditions.hazards.map((hazard) => ({
                    county: loc.locationName,
                    phenomena: hazard.info?.phenomena ?? hazard.phenomena ?? "Unknown",
                    significance: hazard.info?.significance ?? hazard.significance ?? "Unknown",
                    start_time: hazard.validTime?.startTime ?? hazard.startTime ?? "Unknown",
                    end_time: hazard.validTime?.endTime ?? hazard.endTime ?? "Unknown",
                })),
            );

            const suffix = county ? ` for ${county}` : "";
            const text =
                alerts.length === 0
                    ? `No active weather alerts${suffix}`
                    : `Active weather alerts${suffix}:\n\n${alerts.map(formatTWAlert).join("\n")}`;

            return { content: [{ type: "text", text }], structuredContent: alerts };
        },
    );

    return server;
}

// One factory serves both protocol eras.
serveStdio(buildServer, {
    onerror: (error) => {
        console.error("Weather MCP Server error:", error);
    },
});
console.error("Weather MCP Server running on stdio");