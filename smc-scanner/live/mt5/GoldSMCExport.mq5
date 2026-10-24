//+------------------------------------------------------------------+
//| GoldSMCExport.mq5                                                |
//| Writes this chart's closed candles to the MT5 Common Files       |
//| folder (Common\Files\GoldSMC) for the Gold SMC Scanner.          |
//| It only reads prices. It never places, changes or closes orders. |
//+------------------------------------------------------------------+
#property copyright   "Gold SMC Scanner"
#property version     "1.00"
#property description "Writes this chart's closed candles to Common\\Files\\GoldSMC for the Gold SMC Scanner."
#property description "Reads prices only: it never places, changes or closes orders."

input ENUM_TIMEFRAMES InpTimeframe = PERIOD_M5;   // Candles to export
input int             InpBars      = 50000;       // Closed candles kept in the file
input int             InpSeconds   = 10;          // Look for a new candle every (seconds)

string   g_symbol    = "";
string   g_tfName    = "";
int      g_digits    = 2;
datetime g_lastBar   = 0;
datetime g_lastState = 0;
bool     g_warned    = false;

ENUM_TIMEFRAMES Tf()
  {
   if(InpTimeframe == PERIOD_CURRENT)
      return((ENUM_TIMEFRAMES)_Period);
   return(InpTimeframe);
  }

// "PERIOD_M5" -> "M5"
string TfName(ENUM_TIMEFRAMES tf)
  {
   string s = EnumToString(tf);
   return(StringSubstr(s, 7));
  }

string BasePath()
  {
   return("GoldSMC\\" + g_symbol + "_" + g_tfName);
  }

// The broker's server time minus UTC, in minutes, rounded to 30 minutes.
int ServerOffsetMinutes()
  {
   long diff = (long)TimeTradeServer() - (long)TimeGMT();
   return((int)MathRound(diff / 1800.0) * 30);
  }

// Write to a temporary file, then swap it in, so the scanner never reads half a file.
bool SwapIn(string tmp, string name)
  {
   if(!FileMove(tmp, FILE_COMMON, name, FILE_COMMON | FILE_REWRITE))
     {
      PrintFormat("GoldSMCExport: could not replace %s (error %d)", name, GetLastError());
      return(false);
     }
   return(true);
  }

bool WriteCandles()
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   // position 1 is the newest closed candle; the forming candle (position 0) is left out
   int n = CopyRates(g_symbol, Tf(), 1, InpBars, r);
   if(n <= 0)
     {
      if(!g_warned)
         PrintFormat("GoldSMCExport: no %s %s candles yet (error %d); MT5 may still be downloading history",
                     g_symbol, g_tfName, GetLastError());
      g_warned = true;
      return(false);
     }
   g_warned = false;
   string name = BasePath() + ".csv";
   string tmp = name + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("GoldSMCExport: could not write %s (error %d)", tmp, GetLastError());
      return(false);
     }
   FileWriteString(h, "time,open,high,low,close,tickvolume\r\n");
   for(int k = 0; k < n; k++)
     {
      FileWriteString(h, TimeToString(r[k].time, TIME_DATE | TIME_SECONDS) + "," +
                      DoubleToString(r[k].open, g_digits) + "," +
                      DoubleToString(r[k].high, g_digits) + "," +
                      DoubleToString(r[k].low, g_digits) + "," +
                      DoubleToString(r[k].close, g_digits) + "," +
                      IntegerToString(r[k].tick_volume) + "\r\n");
     }
   FileClose(h);
   if(!SwapIn(tmp, name))
      return(false);
   g_lastBar = r[n - 1].time;
   return(true);
  }

// The scanner treats a status older than 3 minutes as "MT5 or the expert is not running".
void WriteState()
  {
   string connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0 ? "true" : "false";
   string json = "{\"symbol\":\"" + g_symbol + "\"" +
                 ",\"timeframe\":\"" + g_tfName + "\"" +
                 ",\"serverOffsetMinutes\":" + IntegerToString(ServerOffsetMinutes()) +
                 ",\"writtenUtc\":" + IntegerToString((long)TimeGMT()) +
                 ",\"lastCandle\":\"" + TimeToString(g_lastBar, TIME_DATE | TIME_SECONDS) + "\"" +
                 ",\"connected\":" + connected +
                 ",\"version\":1}";
   string name = BasePath() + ".json";
   string tmp = name + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("GoldSMCExport: could not write %s (error %d)", tmp, GetLastError());
      return;
     }
   FileWriteString(h, json);
   FileClose(h);
   if(SwapIn(tmp, name))
      g_lastState = TimeLocal();
  }

void Export(bool force)
  {
   datetime newest = iTime(g_symbol, Tf(), 1);
   bool wrote = false;
   if(newest > 0 && (force || newest != g_lastBar))
      wrote = WriteCandles();
   if(force || wrote || TimeLocal() - g_lastState >= 30)
      WriteState();
  }

int OnInit()
  {
   g_symbol = _Symbol;
   g_tfName = TfName(Tf());
   g_digits = (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
   FolderCreate("GoldSMC", FILE_COMMON);
   EventSetTimer((int)MathMax(1, InpSeconds));
   Export(true);
   PrintFormat("GoldSMCExport: writing %s %s candles to %s\\Files\\%s.csv",
               g_symbol, g_tfName, TerminalInfoString(TERMINAL_COMMONDATA_PATH), BasePath());
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   Export(false);
  }

void OnTick()
  {
  }
//+------------------------------------------------------------------+
