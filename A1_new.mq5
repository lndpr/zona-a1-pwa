//+------------------------------------------------------------------+
//|                    ZONA EA BY MATARYCLUB                         |
//|    Entry : ZONE ONLY + BR1/BR2 | BREAK CONFIRMED BY CLOSE       |
//|    v7.19 : v7.18 + DAY RECOVERY (lewat jam end jika hari rugi)  |
//|    v7.22 : direct zone touch push event + v7.21 logic      |
//+------------------------------------------------------------------+
#property copyright "MATARYCLUB"
#property version   "7.26"

#include <Trade\Trade.mqh>
CTrade trade;

enum BreakMode
{
   ZONE_ONLY
};

input group "=== ZONA SETTINGS ==="
input BreakMode EntryBreakMode   = ZONE_ONLY; // Hanya satu break terkonfirmasi, lalu tunggu harga masuk zona

input group "=== M5 FILTER ==="
input bool            UseM5Filter = true;
input ENUM_TIMEFRAMES M5_TF       = PERIOD_M5;

input group "=== EA SETTINGS ==="
input double LotSize             = 0.1;
input int    MagicNumber         = 20250329;
input int    Slippage            = 10;

input group "=== RECOVERY LOT ==="
input bool   UseRecoveryLot       = true;   // lot naik setelah trade loss
input double RecoveryMultiplier   = 2.0;    // lot = LotSize x multiplier^(jumlah loss beruntun)
input int    RecoveryMaxSteps     = 3;      // batas step (0.1 -> 0.2 -> 0.4 -> 0.8)
input double RecoveryMaxLot       = 1.0;    // batas lot absolut

input group "=== RISK CONTROL ==="
input int    MaxTotalPositions   = 2;
input int    EntryCooldownSec    = 10;

input group "=== WEB SIGNAL ==="
input bool   SendWebSignal       = true;
input string SignalApiUrl        = "https://zona-a1-signal-api.landungprakoso14.workers.dev/api/signal";
input string SignalApiKey        = "zona-live-8x2k9m";
input string SignalAccountLabel  = "Live-1";

input group "=== WEB ZONE DASHBOARD ==="
input bool   SendZoneSnapshot    = true;
input bool   SendZoneTrigger     = true; // Kirim event sentuhan zona langsung, tidak menunggu Cron
input string ZoneApiUrl          = "https://zona-a1-signal-api.landungprakoso14.workers.dev/api/zones";
input string ZoneApiKey          = ""; // Isi sama dengan secret ZONES_API_KEY di Cloudflare Worker

input group "=== 4 EMA TREND FILTER ==="
input bool            UseEMAFilter  = true;
input int             EMA_Fast      = 20;
input int             EMA_Mid       = 50;
input int             EMA_Slow      = 100;
input int             EMA_Trend     = 200;
input ENUM_TIMEFRAMES EMA_TF        = PERIOD_CURRENT;
input bool            EMA_RequireStack = true;   // BUY: 20>50>100>200 | SELL: 20<50<100<200
input bool            EMA_RequirePrice = true;   // BUY: price > EMA20 | SELL: price < EMA20

input group "=== DAILY LOGIC ==="
input bool   UseDailyProfitTarget  = true;
input double DailyProfitTarget     = 20.0;
input bool   UseDailyLossLimit     = true;
input double DailyLossLimit        = 30.0;
input bool   UseMaxTradesPerDay    = false;
input int    MaxTradesPerDay       = 5;

input group "=== WAKTU TRADING ==="
input bool   UseTradeTime          = false;
input int    TradeStartHour        = 8;
input int    TradeStartMinute      = 0;
input int    TradeEndHour          = 20;
input int    TradeEndMinute        = 0;

input group "=== DAY RECOVERY (ABAIKAN JAM END) ==="
input bool   UseDayRecovery        = true;   // hari ini rugi -> lanjut trading lewat jam end sampai balik ke target
input double DayRecoveryTargetPnL  = 0.0;    // berhenti saat PnL realized hari ini >= nilai ini (0 = balik modal)

input group "=== ENTRY ==="
input bool   UseEQZone_Entry      = true;
input bool   UseGoldenZone_Entry  = true;
input bool   UseInvalidateOnShift = true;   // UseInvalidateOnShift (true=WAITING jika tanpa break kiri)
input bool   UseMaxZoneRange      = true;
input double MaxZoneRangePips     = 500;

enum ENUM_CONFIRM { CONF_RSI=2 };
input group "=== ENTRY CONFIRMATION ==="
input ENUM_CONFIRM ConfirmMode   = CONF_RSI; // RSI: sentuh zona lalu RSI keluar OB/OS pada candle close
input int    RSI_Period         = 14;
input double RSI_BuyLevel       = 35.0;   // BUY: RSI balik naik melewati level ini
input double RSI_SellLevel      = 65.0;   // SELL: RSI balik turun melewati level ini

input group "=== BR2 ZONE - SL & TP ==="
input double EQ_SL_Buffer_Pct    = 0.1;
input double EQ_TP_RR            = 1.5;

input group "=== BR1 ZONE - SL & TP ==="
input double GZ_SL_Buffer_Pct    = 0.1;
input double GZ_TP_RR            = 2.0;

input group "=== SL & TP MANUAL ==="
input bool   UseManualSLTP       = false;
input int    ManualSL_Points     = 500;
input int    ManualTP_Points     = 1000;

input group "=== BREAK EVEN ==="
input bool   EnableBE             = true;
input int    BE_TriggerPips       = 50;
input int    BE_BufferPips        = 5;

input group "=== TRAILING STOP ==="
input bool   EnableTrailing       = true;
input int    Trail_DistancePips   = 20;
input int    Trail_StepPips       = 5;

#define SWINGS_LENGTH  50
#define LABEL_OFFSET   20
#define EXPIRE_DATE    "2026.12.30"

bool     g_isVisual         = false;
double   g_trailTop         = 0;
double   g_trailBottom      = 1e10;
datetime g_trailBarTime     = 0;
datetime g_lastTopTime      = 0;
datetime g_lastBotTime      = 0;
double   g_swingHighCur     = EMPTY_VALUE;
double   g_swingHighLast    = EMPTY_VALUE;
bool     g_swingHighCrossed = false;
datetime g_swingHighTime    = 0;
double   g_swingLowCur      = EMPTY_VALUE;
double   g_swingLowLast     = EMPTY_VALUE;
bool     g_swingLowCrossed  = false;
datetime g_swingLowTime     = 0;
int      g_swingBias        = 0;
int      g_lastLeg          = -1;
double   g_hiRing[];
double   g_loRing[];
datetime g_tmRing[];
int      g_ringSize         = 0;
int      g_ringHead         = 0;
int      g_bullBreakCount   = 0;
int      g_bearBreakCount   = 0;
bool     g_bullSignalReady  = false;
bool     g_bearSignalReady  = false;
datetime g_lastBarTime      = 0;
datetime g_lastBullBreakTime= 0;
datetime g_lastBearBreakTime= 0;
bool     g_eqBullEntryDone  = false;
bool     g_eqBearEntryDone  = false;
bool     g_gzBullEntryDone  = false;
bool     g_gzBearEntryDone  = false;
bool     g_bullSignalLocked = false;
bool     g_bearSignalLocked = false;
bool     g_eqZoneTouched    = false;
bool     g_gzZoneTouched    = false;

// Entry confirmation state: price must touch the zone first, then RSI must
// leave oversold/overbought on a fully closed candle.
bool     g_eqBuyZoneSeen=false, g_eqSellZoneSeen=false;
bool     g_gzBuyZoneSeen=false, g_gzSellZoneSeen=false;
bool     g_eqBuyOSSeen=false, g_eqSellOBSeen=false;
bool     g_gzBuyOSSeen=false, g_gzSellOBSeen=false;

double   m5_trailTop         = 0;
double   m5_trailBottom      = 1e10;
datetime m5_trailBarTime     = 0;
datetime m5_lastTopTime      = 0;
datetime m5_lastBotTime      = 0;
double   m5_swingHighCur     = EMPTY_VALUE;
double   m5_swingLowCur      = EMPTY_VALUE;
bool     m5_swingHighCrossed = false;
bool     m5_swingLowCrossed  = false;
datetime m5_swingHighTime    = 0;
datetime m5_swingLowTime     = 0;
int      m5_swingBias        = 0;
int      m5_lastLeg          = -1;
double   m5_hiRing[];
double   m5_loRing[];
datetime m5_tmRing[];
int      m5_ringSize         = 0;
int      m5_ringHead         = 0;
int      m5_bullBreakCount   = 0;
int      m5_bearBreakCount   = 0;
bool     m5_bullSignalReady  = false;
bool     m5_bearSignalReady  = false;
bool     m5_bullSignalLocked = false;
bool     m5_bearSignalLocked = false;
datetime m5_lastBarTime      = 0;

int      g_emaFastHandle    = INVALID_HANDLE;
int      g_emaMidHandle     = INVALID_HANDLE;
int      g_emaSlowHandle    = INVALID_HANDLE;
int      g_emaTrendHandle   = INVALID_HANDLE;
int      g_rsiHandle        = INVALID_HANDLE;
double   g_emaFast          = 0;
double   g_emaMid           = 0;
double   g_emaSlow          = 0;
double   g_emaTrend         = 0;

double   g_curLot           = 0.0;   // lot terakhir yang dipakai (recovery)
int      CountConsecutiveLosses(bool force=false);
double   GetEntryLot(bool force=false);
datetime g_todayDate        = 0;
double   g_dayStartBalance  = 0;
bool     g_dayDone          = false;
int      g_dayTradeCount    = 0;
bool     g_isExpired        = false;
datetime g_lastEntryTime    = 0;
bool     g_entryBusy        = false; // Anti-duplicate entry lock

struct TradeInfo
{
   ulong    ticket;
   int      type;
   int      zone;
   double   entryPrice;
   double   sl;
   double   tp;
   bool     beSet;
   double   trailSL;
};
TradeInfo g_trades[];
datetime g_lastZoneSnapshotTime=0;
string   g_lastZoneSnapshotState="";
string   g_lastZoneTriggerBR1="";
string   g_lastZoneTriggerBR2="";
datetime g_lastZoneTriggerAttemptBR1=0;
datetime g_lastZoneTriggerAttemptBR2=0;

color Transp(color clr,int alpha){return(color)(((uint)alpha<<24)|((uint)clr&0x00FFFFFF));}

void SetBox(string nm,datetime t1,double p1,datetime t2,double p2,color bg,color border,int alpha=40)
{
   if(!g_isVisual) return;
   if(ObjectFind(0,nm)<0) ObjectCreate(0,nm,OBJ_RECTANGLE,0,t1,p1,t2,p2);
   ObjectSetInteger(0,nm,OBJPROP_TIME,0,t1);  ObjectSetDouble(0,nm,OBJPROP_PRICE,0,p1);
   ObjectSetInteger(0,nm,OBJPROP_TIME,1,t2);  ObjectSetDouble(0,nm,OBJPROP_PRICE,1,p2);
   ObjectSetInteger(0,nm,OBJPROP_COLOR,border);ObjectSetInteger(0,nm,OBJPROP_BGCOLOR,Transp(bg,alpha));
   ObjectSetInteger(0,nm,OBJPROP_FILL,true);ObjectSetInteger(0,nm,OBJPROP_BACK,true);
   ObjectSetInteger(0,nm,OBJPROP_WIDTH,1);ObjectSetInteger(0,nm,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,nm,OBJPROP_HIDDEN,true);
}
void SetText(string nm,datetime t,double p,string txt,color clr,int fs=9,ENUM_ANCHOR_POINT anc=ANCHOR_LEFT)
{
   if(!g_isVisual) return;
   if(ObjectFind(0,nm)<0) ObjectCreate(0,nm,OBJ_TEXT,0,t,p);
   ObjectSetString(0,nm,OBJPROP_TEXT,txt);ObjectSetInteger(0,nm,OBJPROP_TIME,t);
   ObjectSetDouble(0,nm,OBJPROP_PRICE,p);ObjectSetInteger(0,nm,OBJPROP_COLOR,clr);
   ObjectSetInteger(0,nm,OBJPROP_FONTSIZE,fs);ObjectSetInteger(0,nm,OBJPROP_ANCHOR,anc);
   ObjectSetInteger(0,nm,OBJPROP_BACK,false);ObjectSetInteger(0,nm,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,nm,OBJPROP_HIDDEN,true);
}
void SetHLine(string nm,double p,color clr,int w,ENUM_LINE_STYLE st)
{
   if(!g_isVisual) return;
   if(ObjectFind(0,nm)<0) ObjectCreate(0,nm,OBJ_HLINE,0,0,p);
   ObjectSetDouble(0,nm,OBJPROP_PRICE,p);ObjectSetInteger(0,nm,OBJPROP_COLOR,clr);
   ObjectSetInteger(0,nm,OBJPROP_WIDTH,w);ObjectSetInteger(0,nm,OBJPROP_STYLE,st);
   ObjectSetInteger(0,nm,OBJPROP_BACK,true);ObjectSetInteger(0,nm,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,nm,OBJPROP_HIDDEN,true);
}
void SetTrend(string nm,datetime t1,double p1,datetime t2,double p2,color clr,int w=1)
{
   if(!g_isVisual) return;
   if(ObjectFind(0,nm)<0) ObjectCreate(0,nm,OBJ_TREND,0,t1,p1,t2,p2);
   ObjectSetInteger(0,nm,OBJPROP_TIME,0,t1);ObjectSetDouble(0,nm,OBJPROP_PRICE,0,p1);
   ObjectSetInteger(0,nm,OBJPROP_TIME,1,t2);ObjectSetDouble(0,nm,OBJPROP_PRICE,1,p2);
   ObjectSetInteger(0,nm,OBJPROP_COLOR,clr);ObjectSetInteger(0,nm,OBJPROP_WIDTH,w);
   ObjectSetInteger(0,nm,OBJPROP_STYLE,STYLE_SOLID);ObjectSetInteger(0,nm,OBJPROP_RAY_RIGHT,false);
   ObjectSetInteger(0,nm,OBJPROP_BACK,false);ObjectSetInteger(0,nm,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,nm,OBJPROP_HIDDEN,true);
}
void DelAll()
{
   if(!g_isVisual) return;
   for(int i=ObjectsTotal(0)-1;i>=0;i--)
   {string n=ObjectName(0,i);if(StringFind(n,"ZONA_")==0)ObjectDelete(0,n);}
}

void UpdateEMA()
{
   if(!UseEMAFilter) return;
   double b[1];
   if(g_emaFastHandle!=INVALID_HANDLE && CopyBuffer(g_emaFastHandle,0,0,1,b)==1) g_emaFast=b[0];
   if(g_emaMidHandle!=INVALID_HANDLE && CopyBuffer(g_emaMidHandle,0,0,1,b)==1) g_emaMid=b[0];
   if(g_emaSlowHandle!=INVALID_HANDLE && CopyBuffer(g_emaSlowHandle,0,0,1,b)==1) g_emaSlow=b[0];
   if(g_emaTrendHandle!=INVALID_HANDLE && CopyBuffer(g_emaTrendHandle,0,0,1,b)==1) g_emaTrend=b[0];
}
bool EMAStackBull()
{
   return (g_emaFast>g_emaMid && g_emaMid>g_emaSlow && g_emaSlow>g_emaTrend);
}
bool EMAStackBear()
{
   return (g_emaFast<g_emaMid && g_emaMid<g_emaSlow && g_emaSlow<g_emaTrend);
}
bool EMAAllowBuy()
{
   if(!UseEMAFilter) return true;
   double price=iClose(_Symbol,PERIOD_CURRENT,0);
   if(EMA_RequireStack && !EMAStackBull()) return false;
   if(EMA_RequirePrice && price<=g_emaFast) return false;
   return true;
}
bool EMAAllowSell()
{
   if(!UseEMAFilter) return true;
   double price=iClose(_Symbol,PERIOD_CURRENT,0);
   if(EMA_RequireStack && !EMAStackBear()) return false;
   if(EMA_RequirePrice && price>=g_emaFast) return false;
   return true;
}

bool M5AllowBuy()
{
   if(!UseM5Filter) return true;
   return (m5_bullSignalReady && !m5_bullSignalLocked);
}
bool M5AllowSell()
{
   if(!UseM5Filter) return true;
   return (m5_bearSignalReady && !m5_bearSignalLocked);
}
string M5StatusText()
{
   if(!UseM5Filter) return "";
   string modeStr="[ZONE ONLY]";
   if(m5_bullSignalReady && !m5_bullSignalLocked) return " | M5 BUY READY "+modeStr;
   if(m5_bearSignalReady && !m5_bearSignalLocked) return " | M5 SELL READY "+modeStr;
   return " | M5 WAITING";
}

double FiboPrice(double hi,double lo,double ratio,bool bull)
{return bull?hi-ratio*(hi-lo):lo+ratio*(hi-lo);}
bool IsBullishFibo(){return g_swingBias==1;}

void GetEQBounds(double &eTop,double &eBot)
{eTop=0.525*g_trailTop+0.475*g_trailBottom;eBot=0.525*g_trailBottom+0.475*g_trailTop;}
void GetGZBounds(double &gTop,double &gBot,bool bull)
{double l62=FiboPrice(g_trailTop,g_trailBottom,0.62,bull),l77=FiboPrice(g_trailTop,g_trailBottom,0.77,bull);
 gTop=MathMax(l62,l77);gBot=MathMin(l62,l77);}

bool InEQZone(double p)
{
   double eT,eB;GetEQBounds(eT,eB);if(p<eB||p>eT)return false;
   if(UseMaxZoneRange&&(eT-eB)/_Point>MaxZoneRangePips)return false;
   if(g_eqZoneTouched)return false;
   return true;
}
bool InGoldenZone(double p,bool bull)
{
   double gT,gB;GetGZBounds(gT,gB,bull);if(p<gB||p>gT)return false;
   if(UseMaxZoneRange&&(gT-gB)/_Point>MaxZoneRangePips)return false;
   if(g_gzZoneTouched)return false;
   return true;
}

// Confirmation: zone touch is latched first. After that, RSI must enter
// OS/OB and then cross back out on a CLOSED candle (shift 1).
bool RSIOK(bool isBuy,double zTop,double zBot,double px,
           bool &zoneSeen,bool &extremeSeen)
{
   if(g_rsiHandle==INVALID_HANDLE) return false;

   datetime closedBar=iTime(_Symbol,PERIOD_CURRENT,1);
   if(closedBar<=(isBuy?g_lastBullBreakTime:g_lastBearBreakTime)) return false;

   // Latch any live price touch or a touch by the last closed candle.
   bool touchedNow=(px>=zBot && px<=zTop);
   if(!touchedNow)
   {
      double barHigh=iHigh(_Symbol,PERIOD_CURRENT,1);
      double barLow =iLow(_Symbol,PERIOD_CURRENT,1);
      touchedNow=(barHigh>=zBot && barLow<=zTop);
   }
   if(touchedNow) zoneSeen=true;
   if(!zoneSeen) return false;

   double r[];
   ArrayResize(r,2);
   ArraySetAsSeries(r,true);
   if(CopyBuffer(g_rsiHandle,0,1,2,r)<2) return false;
   // r[0] = latest closed candle, r[1] = previous closed candle.
   if(isBuy)
   {
      if(r[0]<=RSI_BuyLevel) extremeSeen=true;
      return (extremeSeen && r[1]<=RSI_BuyLevel && r[0]>RSI_BuyLevel);
   }

   if(r[0]>=RSI_SellLevel) extremeSeen=true;
   return (extremeSeen && r[1]>=RSI_SellLevel && r[0]<RSI_SellLevel);
}
bool EQEntryOK(double p,bool bull)
{
   double eT,eB;GetEQBounds(eT,eB);
   if(UseMaxZoneRange&&(eT-eB)/_Point>MaxZoneRangePips)return false;
   if(g_eqZoneTouched)return false;
   if(bull) return RSIOK(true,eT,eB,p,g_eqBuyZoneSeen,g_eqBuyOSSeen);
    return RSIOK(false,eT,eB,p,g_eqSellZoneSeen,g_eqSellOBSeen);
}
bool GZEntryOK(double p,bool bull)
{
   double gT,gB;GetGZBounds(gT,gB,bull);
   if(UseMaxZoneRange&&(gT-gB)/_Point>MaxZoneRangePips)return false;
   if(g_gzZoneTouched)return false;
   if(bull) return RSIOK(true,gT,gB,p,g_gzBuyZoneSeen,g_gzBuyOSSeen);
    return RSIOK(false,gT,gB,p,g_gzSellZoneSeen,g_gzSellOBSeen);
}

void DrawZones()
{
   if(!g_isVisual) return;
   double hi=g_trailTop,lo=g_trailBottom,mid=(hi+lo)*0.5;
   datetime t0=g_trailBarTime;
   datetime t1=TimeCurrent()+(datetime)((long)LABEL_OFFSET*(long)PeriodSeconds());
   datetime tm=t0+(t1-t0)/2;
   bool bull=IsBullishFibo();

   double eT=0.525*hi+0.475*lo,eB=0.525*lo+0.475*hi;
   SetBox("ZONA_EqBox",t0,eT,t1,eB,clrGray,clrGray,40);
   SetText("ZONA_EqInner",tm,(eT+eB)*0.5,bull?"  BR2 BUY":"  BR2 SELL",bull?clrGreen:clrRed,9,ANCHOR_LEFT);
   SetText("ZONA_EqPriceT",t1,eT,DoubleToString(eT,_Digits),clrGray,8,ANCHOR_LEFT);
   SetText("ZONA_EqPriceB",t1,eB,DoubleToString(eB,_Digits),clrGray,8,ANCHOR_LEFT);

   double l62=FiboPrice(hi,lo,0.62,bull),l77=FiboPrice(hi,lo,0.77,bull);
   double gT=MathMax(l62,l77),gB=MathMin(l62,l77);
   datetime sT=(g_lastTopTime<g_lastBotTime)?g_lastTopTime:g_lastBotTime;
   SetBox("ZONA_GZBox",sT,gT,t1,gB,clrOrangeRed,clrOrangeRed,40);
   SetText("ZONA_GZT",t1,gT,DoubleToString(gT,_Digits),clrOrangeRed,8,ANCHOR_LEFT);
   SetText("ZONA_GZB",t1,gB,DoubleToString(gB,_Digits),clrOrangeRed,8,ANCHOR_LEFT);
   SetText("ZONA_GZM",(datetime)((int)sT+(int)(t1-sT)/2),(gT+gB)*0.5,
           bull?"  BR1 BUY":"  BR1 SELL",bull?clrGreen:clrRed,9,ANCHOR_LEFT);

   SetHLine("ZONA_TopLine",hi, clrRed,  1,STYLE_DASH);
   SetHLine("ZONA_BotLine",lo, clrGreen,1,STYLE_DASH);
   SetHLine("ZONA_MidLine",mid,clrGray, 1,STYLE_DOT);

   if(UseEMAFilter && g_emaFast>0)
   {
      string emaTrend=EMAAllowBuy()?"▲ BULL STACK":(EMAAllowSell()?"▼ BEAR STACK":"✗ NO ALIGN");
      color  emaCol=EMAAllowBuy()?clrLime:(EMAAllowSell()?clrRed:clrGold);
      SetText("ZONA_EMAStatus",t0,lo,
              "EMA "+IntegerToString(EMA_Fast)+"/"+IntegerToString(EMA_Mid)+"/"+
              IntegerToString(EMA_Slow)+"/"+IntegerToString(EMA_Trend)+" | "+emaTrend,
              emaCol,8,ANCHOR_LEFT_LOWER);
   }

   double realizedPnL=AccountInfoDouble(ACCOUNT_BALANCE)-g_dayStartBalance;
   string dayStatus=g_dayDone?"DONE":"ACTIVE";
   string tradeStr=UseMaxTradesPerDay?" | Trades:"+IntegerToString(g_dayTradeCount)+"/"+IntegerToString(MaxTradesPerDay):"";
   string timeStr="";
   if(UseTradeTime)
   {
      string tStatus=IsTradeTime()?"✓ TRADE":(IsDayRecoveryActive()?"↻ RECOV":"✗ OFF");
      timeStr=" | "+IntegerToString(TradeStartHour)+":"+
               (TradeStartMinute<10?"0":"")+IntegerToString(TradeStartMinute)+
               "-"+IntegerToString(TradeEndHour)+":"+
               (TradeEndMinute<10?"0":"")+IntegerToString(TradeEndMinute)+
               " ["+tStatus+"]";
   }
   string modeStr="[ZONE ONLY]";
   string sigBull="Bull break confirmed";
   string sigBear="Bear break confirmed";
   string sig=(g_bullSignalReady&&!g_bullSignalLocked)?"BUY READY "+modeStr+" ["+sigBull+"]":
              (g_bearSignalReady&&!g_bearSignalLocked)?"SELL READY "+modeStr+" ["+sigBear+"]":
              (g_bullSignalLocked||g_bearSignalLocked)?"LOCKED":
              "Waiting candle-close break [ZONE ONLY]...";
   string bs=g_swingBias==1?"BULLISH":g_swingBias==-1?"BEARISH":"NEUTRAL";
   color  stCol=g_dayDone?clrGray:clrWhite;
   string lotStr=UseRecoveryLot?" | NextLot="+DoubleToString(GetEntryLot(),2)+" (L"+IntegerToString(CountConsecutiveLosses())+")":"";
   double eT2,eB2; GetEQBounds(eT2,eB2);
   double gT2,gB2; GetGZBounds(gT2,gB2,bull);
   string zoneRangeStr=UseMaxZoneRange?
      " | BR2:"+DoubleToString((eT2-eB2)/_Point,0)+"pts BR1:"+DoubleToString((gT2-gB2)/_Point,0)+
      "pts(max:"+DoubleToString(MaxZoneRangePips,0)+")":"";
   SetText("ZONA_Status",t0,hi,
           "Bias:"+bs+" | "+sig+M5StatusText()+lotStr+zoneRangeStr+timeStr+" | Day["+dayStatus+"]: $"+
           DoubleToString(realizedPnL,2)+tradeStr,stCol,9,ANCHOR_LEFT_UPPER);
}
void DrawStrucLine(string nm,datetime t1,double p,datetime t2,string tag,color clr,bool bear)
{
   if(!g_isVisual) return;
   SetTrend("ZONA_STR_"+nm,t1,p,t2,p,clr,1);
   SetText("ZONA_STRL_"+nm,t1+(t2-t1)/2,p,tag,clr,9,bear?ANCHOR_LOWER:ANCHOR_UPPER);
}

void ProcessBullBreak(datetime barTime,double breakLevel,datetime swingTime)
{
   g_lastBullBreakTime=barTime;
   g_bullBreakCount=1;
   g_bearBreakCount=0;
   g_bullSignalReady=true;
   g_bearSignalReady=false;
   g_eqBullEntryDone=false;
   g_gzBullEntryDone=false;
   g_eqZoneTouched=false;
   g_gzZoneTouched=false;
   g_bullSignalLocked=false;
   g_bearSignalLocked=false;
}
void ProcessBearBreak(datetime barTime,double breakLevel,datetime swingTime)
{
   g_lastBearBreakTime=barTime;
   g_bearBreakCount=1;
   g_bullBreakCount=0;
   g_bearSignalReady=true;
   g_bullSignalReady=false;
   g_eqBearEntryDone=false;
   g_gzBearEntryDone=false;
   g_eqZoneTouched=false;
   g_gzZoneTouched=false;
   g_bearSignalLocked=false;
   g_bullSignalLocked=false;
}

void ProcessM5BullBreak()
{
   m5_bullBreakCount=1;
   m5_bearBreakCount=0;
   m5_bullSignalReady=true;
   m5_bearSignalReady=false;
   m5_bullSignalLocked=false;
   m5_bearSignalLocked=false;
}
void ProcessM5BearBreak()
{
   m5_bearBreakCount=1;
   m5_bullBreakCount=0;
   m5_bearSignalReady=true;
   m5_bullSignalReady=false;
   m5_bearSignalLocked=false;
   m5_bullSignalLocked=false;
}

void FullScan()
{
   int rt=Bars(_Symbol,PERIOD_CURRENT);
   int size=SWINGS_LENGTH;
   if(rt<size*2+2) return;
   double hi[],lo[],cl[]; datetime tm[];
   ArraySetAsSeries(hi,false);ArraySetAsSeries(lo,false);ArraySetAsSeries(cl,false);ArraySetAsSeries(tm,false);
   if(CopyHigh(_Symbol,PERIOD_CURRENT,0,rt,hi)<rt)return;
   if(CopyLow (_Symbol,PERIOD_CURRENT,0,rt,lo)<rt)return;
   if(CopyClose(_Symbol,PERIOD_CURRENT,0,rt,cl)<rt)return;
   if(CopyTime(_Symbol,PERIOD_CURRENT,0,rt,tm)<rt)return;

   g_trailTop=hi[size];g_trailBottom=lo[size];g_trailBarTime=tm[size];
   g_lastTopTime=tm[size];g_lastBotTime=tm[size];
   g_swingHighCur=EMPTY_VALUE;g_swingHighLast=EMPTY_VALUE;g_swingHighCrossed=false;g_swingHighTime=0;
   g_swingLowCur=EMPTY_VALUE;g_swingLowLast=EMPTY_VALUE;g_swingLowCrossed=false;g_swingLowTime=0;
   g_lastLeg=-1;g_swingBias=0;g_bullBreakCount=0;g_bearBreakCount=0;
   g_bullSignalReady=false;g_bearSignalReady=false;
   if(g_isVisual) DelAll();

   for(int cur=size;cur<rt;cur++)
   {
      int pivot=cur-size;
      double hh=hi[pivot+1],ll=lo[pivot+1];
      for(int k=pivot+2;k<=cur;k++){if(hi[k]>hh)hh=hi[k];if(lo[k]<ll)ll=lo[k];}
      bool nlh=hi[pivot]>hh,nll=lo[pivot]<ll;
      int cLeg=g_lastLeg;
      if(nlh)cLeg=0;else if(nll)cLeg=1;
      bool pL=(g_lastLeg==0&&cLeg==1),pH=(g_lastLeg==1&&cLeg==0);
      if(cLeg!=g_lastLeg)g_lastLeg=cLeg;
      if(pL)
      {
         g_swingLowLast=g_swingLowCur;g_swingLowCur=lo[pivot];g_swingLowCrossed=false;
         g_swingLowTime=tm[pivot];g_trailBottom=lo[pivot];g_trailBarTime=tm[pivot];g_lastBotTime=tm[pivot];
         if(UseInvalidateOnShift&&g_lastBearBreakTime>g_swingLowTime){g_bearSignalReady=false;g_bearBreakCount=0;} g_bearSignalLocked=false;
         g_eqBearEntryDone=false;g_gzBearEntryDone=false;
         if(UseInvalidateOnShift&&g_lastBullBreakTime<g_swingLowTime){g_bullSignalReady=false;g_bullBreakCount=0;} // v7.24: samakan dengan IncrementalUpdate
      }
      if(pH)
      {
         g_swingHighLast=g_swingHighCur;g_swingHighCur=hi[pivot];g_swingHighCrossed=false;
         g_swingHighTime=tm[pivot];g_trailTop=hi[pivot];g_trailBarTime=tm[pivot];g_lastTopTime=tm[pivot];
         if(UseInvalidateOnShift&&g_lastBullBreakTime>g_swingHighTime){g_bullSignalReady=false;g_bullBreakCount=0;} g_bullSignalLocked=false;
         g_eqBullEntryDone=false;g_gzBullEntryDone=false;
         if(UseInvalidateOnShift&&g_lastBearBreakTime<g_swingHighTime){g_bearSignalReady=false;g_bearBreakCount=0;} // v7.24: samakan dengan IncrementalUpdate
      }
      if(hi[cur]>g_trailTop){g_trailTop=hi[cur];g_lastTopTime=tm[cur];}
      if(lo[cur]<g_trailBottom){g_trailBottom=lo[cur];g_lastBotTime=tm[cur];}
      if(cur>0&&g_swingHighCur!=EMPTY_VALUE&&g_swingLowCur!=EMPTY_VALUE)
      {
         if(cl[cur]>g_swingHighCur&&cl[cur-1]<=g_swingHighCur&&!g_swingHighCrossed)
         {g_swingHighCrossed=true;g_swingBias=1;ProcessBullBreak(tm[cur],g_swingHighCur,g_swingHighTime);
          DrawStrucLine("BH"+IntegerToString(cur),g_swingHighTime,g_swingHighCur,tm[cur],"CLOSE ↑",clrLime,false);}
         if(cl[cur]<g_swingLowCur&&cl[cur-1]>=g_swingLowCur&&!g_swingLowCrossed)
         {g_swingLowCrossed=true;g_swingBias=-1;ProcessBearBreak(tm[cur],g_swingLowCur,g_swingLowTime);
          DrawStrucLine("BL"+IntegerToString(cur),g_swingLowTime,g_swingLowCur,tm[cur],"CLOSE ↓",clrRed,true);}
      }
   }
   g_ringSize=MathMin(size*2+2,rt);
   ArrayResize(g_hiRing,g_ringSize);ArrayResize(g_loRing,g_ringSize);ArrayResize(g_tmRing,g_ringSize);
   for(int i=0;i<g_ringSize;i++){g_hiRing[i]=hi[rt-g_ringSize+i];g_loRing[i]=lo[rt-g_ringSize+i];g_tmRing[i]=tm[rt-g_ringSize+i];}
   g_ringHead=g_ringSize-1;
   g_swingHighCrossed=false;
   g_swingLowCrossed=false;
   DrawZones();
   if(g_isVisual)ChartRedraw();
}

void FullScanM5()
{
   if(!UseM5Filter) return;
   int rt=Bars(_Symbol,M5_TF);
   int size=SWINGS_LENGTH;
   if(rt<size*2+2) return;
   double hi[],lo[],cl[]; datetime tm[];
   ArraySetAsSeries(hi,false);ArraySetAsSeries(lo,false);ArraySetAsSeries(cl,false);ArraySetAsSeries(tm,false);
   if(CopyHigh(_Symbol,M5_TF,0,rt,hi)<rt)return;
   if(CopyLow (_Symbol,M5_TF,0,rt,lo)<rt)return;
   if(CopyClose(_Symbol,M5_TF,0,rt,cl)<rt)return;
   if(CopyTime(_Symbol,M5_TF,0,rt,tm)<rt)return;

   m5_trailTop=hi[size];m5_trailBottom=lo[size];m5_trailBarTime=tm[size];
   m5_lastTopTime=tm[size];m5_lastBotTime=tm[size];
   m5_swingHighCur=EMPTY_VALUE;m5_swingHighCrossed=false;m5_swingHighTime=0;
   m5_swingLowCur=EMPTY_VALUE;m5_swingLowCrossed=false;m5_swingLowTime=0;
   m5_lastLeg=-1;m5_swingBias=0;m5_bullBreakCount=0;m5_bearBreakCount=0;
   m5_bullSignalReady=false;m5_bearSignalReady=false;
   m5_bullSignalLocked=false;m5_bearSignalLocked=false;

   for(int cur=size;cur<rt;cur++)
   {
      int pivot=cur-size;
      double hh=hi[pivot+1],ll=lo[pivot+1];
      for(int k=pivot+2;k<=cur;k++){if(hi[k]>hh)hh=hi[k];if(lo[k]<ll)ll=lo[k];}
      bool nlh=hi[pivot]>hh,nll=lo[pivot]<ll;
      int cLeg=m5_lastLeg;
      if(nlh)cLeg=0;else if(nll)cLeg=1;
      bool pL=(m5_lastLeg==0&&cLeg==1),pH=(m5_lastLeg==1&&cLeg==0);
      if(cLeg!=m5_lastLeg)m5_lastLeg=cLeg;
      if(pL)
      {
         m5_swingLowCur=lo[pivot];m5_swingLowCrossed=false;m5_swingLowTime=tm[pivot];
         m5_trailBottom=lo[pivot];m5_trailBarTime=tm[pivot];m5_lastBotTime=tm[pivot];
         m5_bearSignalReady=false;m5_bearBreakCount=0;m5_bearSignalLocked=false;
      }
      if(pH)
      {
         m5_swingHighCur=hi[pivot];m5_swingHighCrossed=false;m5_swingHighTime=tm[pivot];
         m5_trailTop=hi[pivot];m5_trailBarTime=tm[pivot];m5_lastTopTime=tm[pivot];
         m5_bullSignalReady=false;m5_bullBreakCount=0;m5_bullSignalLocked=false;
      }
      if(hi[cur]>m5_trailTop){m5_trailTop=hi[cur];m5_lastTopTime=tm[cur];}
      if(lo[cur]<m5_trailBottom){m5_trailBottom=lo[cur];m5_lastBotTime=tm[cur];}
      if(cur>0&&m5_swingHighCur!=EMPTY_VALUE&&m5_swingLowCur!=EMPTY_VALUE)
      {
         if(cl[cur]>m5_swingHighCur&&cl[cur-1]<=m5_swingHighCur&&!m5_swingHighCrossed)
         {m5_swingHighCrossed=true;m5_swingBias=1;ProcessM5BullBreak();}
         if(cl[cur]<m5_swingLowCur&&cl[cur-1]>=m5_swingLowCur&&!m5_swingLowCrossed)
         {m5_swingLowCrossed=true;m5_swingBias=-1;ProcessM5BearBreak();}
      }
   }
   m5_ringSize=MathMin(size*2+2,rt);
   ArrayResize(m5_hiRing,m5_ringSize);ArrayResize(m5_loRing,m5_ringSize);ArrayResize(m5_tmRing,m5_ringSize);
   for(int i=0;i<m5_ringSize;i++){m5_hiRing[i]=hi[rt-m5_ringSize+i];m5_loRing[i]=lo[rt-m5_ringSize+i];m5_tmRing[i]=tm[rt-m5_ringSize+i];}
   m5_ringHead=m5_ringSize-1;
   m5_swingHighCrossed=false;
   m5_swingLowCrossed=false;
}

void IncrementalUpdate()
{
   int size=SWINGS_LENGTH,needed=size*2+2;
   double newHi[],newLo[],newCl[]; datetime newTm[];
   ArrayResize(newHi,1);ArrayResize(newLo,1);ArrayResize(newCl,1);ArrayResize(newTm,1);
   ArraySetAsSeries(newHi,false);ArraySetAsSeries(newLo,false);ArraySetAsSeries(newCl,false);ArraySetAsSeries(newTm,false);
   if(CopyHigh(_Symbol,PERIOD_CURRENT,1,1,newHi)<1)return;
   if(CopyLow (_Symbol,PERIOD_CURRENT,1,1,newLo)<1)return;
   if(CopyClose(_Symbol,PERIOD_CURRENT,1,1,newCl)<1)return;
   if(CopyTime(_Symbol,PERIOD_CURRENT,1,1,newTm)<1)return;

   if(g_ringSize<needed)
   {ArrayResize(g_hiRing,g_ringSize+1);ArrayResize(g_loRing,g_ringSize+1);ArrayResize(g_tmRing,g_ringSize+1);
    g_hiRing[g_ringSize]=newHi[0];g_loRing[g_ringSize]=newLo[0];g_tmRing[g_ringSize]=newTm[0];
    g_ringSize++;g_ringHead=g_ringSize-1;return;}
   else
   {for(int i=0;i<g_ringSize-1;i++){g_hiRing[i]=g_hiRing[i+1];g_loRing[i]=g_loRing[i+1];g_tmRing[i]=g_tmRing[i+1];}
    g_hiRing[g_ringSize-1]=newHi[0];g_loRing[g_ringSize-1]=newLo[0];g_tmRing[g_ringSize-1]=newTm[0];
    g_ringHead=g_ringSize-1;}

   int cur=g_ringHead,pivot=cur-size;
   if(pivot<1)return;
   double hh=g_hiRing[pivot+1],ll=g_loRing[pivot+1];
   for(int k=pivot+2;k<=cur;k++){if(g_hiRing[k]>hh)hh=g_hiRing[k];if(g_loRing[k]<ll)ll=g_loRing[k];}
   bool nlh=g_hiRing[pivot]>hh,nll=g_loRing[pivot]<ll;
   int cLeg=g_lastLeg;
   if(nlh)cLeg=0;else if(nll)cLeg=1;
   bool pL=(g_lastLeg==0&&cLeg==1),pH=(g_lastLeg==1&&cLeg==0);
   if(cLeg!=g_lastLeg)g_lastLeg=cLeg;

   if(pL)
   {
      g_swingLowLast=g_swingLowCur;
      g_swingLowCur=g_loRing[pivot];
      g_swingLowCrossed=false;
      g_swingLowTime=g_tmRing[pivot];
      g_trailBottom=g_loRing[pivot];
      g_trailBarTime=g_tmRing[pivot];
      g_lastBotTime=g_tmRing[pivot];
      g_swingHighCrossed=false;
      if(UseInvalidateOnShift&&g_lastBearBreakTime>g_swingLowTime){g_bearSignalReady=false;g_bearBreakCount=0;} // v7.24: ada break di kiri pivot -> tetap READY; tanpa break kiri -> WAITING
      g_bearSignalLocked=false;
      g_eqBearEntryDone=false;
      g_gzBearEntryDone=false;
      if(UseInvalidateOnShift&&g_lastBullBreakTime<g_swingLowTime){g_bullSignalReady=false;g_bullBreakCount=0;} // v7.24: low baru terbentuk setelah break = zona geser tanpa break, bull tunggu break lagi
   }
   if(pH)
   {
      g_swingHighLast=g_swingHighCur;
      g_swingHighCur=g_hiRing[pivot];
      g_swingHighCrossed=false;
      g_swingHighTime=g_tmRing[pivot];
      g_trailTop=g_hiRing[pivot];
      g_trailBarTime=g_tmRing[pivot];
      g_lastTopTime=g_tmRing[pivot];
      g_swingLowCrossed=false;
      if(UseInvalidateOnShift&&g_lastBullBreakTime>g_swingHighTime){g_bullSignalReady=false;g_bullBreakCount=0;} // v7.24: ada break di kiri pivot -> tetap READY; tanpa break kiri -> WAITING
      g_bullSignalLocked=false;
      g_eqBullEntryDone=false;
      g_gzBullEntryDone=false;
      if(UseInvalidateOnShift&&g_lastBearBreakTime<g_swingHighTime){g_bearSignalReady=false;g_bearBreakCount=0;} // v7.24: high baru terbentuk setelah break = zona geser tanpa break, bear tunggu break lagi
   }

   if(g_hiRing[cur]>g_trailTop){g_trailTop=g_hiRing[cur];g_lastTopTime=g_tmRing[cur];}
   if(g_loRing[cur]<g_trailBottom){g_trailBottom=g_loRing[cur];g_lastBotTime=g_tmRing[cur];}

   if(g_swingHighCur!=EMPTY_VALUE&&g_swingLowCur!=EMPTY_VALUE)
   {
      double clPrev[];ArrayResize(clPrev,1);ArraySetAsSeries(clPrev,false);
      if(CopyClose(_Symbol,PERIOD_CURRENT,2,1,clPrev)<1)return;
      if(newCl[0]>g_swingHighCur&&clPrev[0]<=g_swingHighCur&&!g_swingHighCrossed)
      {g_swingHighCrossed=true;g_swingBias=1;ProcessBullBreak(g_tmRing[cur],g_swingHighCur,g_swingHighTime);
       DrawStrucLine("BH"+TimeToString(g_tmRing[cur]),g_swingHighTime,g_swingHighCur,g_tmRing[cur],"CLOSE ↑",clrLime,false);}
      if(newCl[0]<g_swingLowCur&&clPrev[0]>=g_swingLowCur&&!g_swingLowCrossed)
      {g_swingLowCrossed=true;g_swingBias=-1;ProcessBearBreak(g_tmRing[cur],g_swingLowCur,g_swingLowTime);
       DrawStrucLine("BL"+TimeToString(g_tmRing[cur]),g_swingLowTime,g_swingLowCur,g_tmRing[cur],"CLOSE ↓",clrRed,true);}
   }
   DrawZones();
   if(g_isVisual)ChartRedraw();
}

void IncrementalUpdateM5()
{
   if(!UseM5Filter) return;
   int size=SWINGS_LENGTH,needed=size*2+2;
   double newHi[],newLo[],newCl[]; datetime newTm[];
   ArrayResize(newHi,1);ArrayResize(newLo,1);ArrayResize(newCl,1);ArrayResize(newTm,1);
   ArraySetAsSeries(newHi,false);ArraySetAsSeries(newLo,false);ArraySetAsSeries(newCl,false);ArraySetAsSeries(newTm,false);
   if(CopyHigh(_Symbol,M5_TF,1,1,newHi)<1)return;
   if(CopyLow (_Symbol,M5_TF,1,1,newLo)<1)return;
   if(CopyClose(_Symbol,M5_TF,1,1,newCl)<1)return;
   if(CopyTime(_Symbol,M5_TF,1,1,newTm)<1)return;

   if(m5_ringSize<needed)
   {ArrayResize(m5_hiRing,m5_ringSize+1);ArrayResize(m5_loRing,m5_ringSize+1);ArrayResize(m5_tmRing,m5_ringSize+1);
    m5_hiRing[m5_ringSize]=newHi[0];m5_loRing[m5_ringSize]=newLo[0];m5_tmRing[m5_ringSize]=newTm[0];
    m5_ringSize++;m5_ringHead=m5_ringSize-1;return;}
   else
   {for(int i=0;i<m5_ringSize-1;i++){m5_hiRing[i]=m5_hiRing[i+1];m5_loRing[i]=m5_loRing[i+1];m5_tmRing[i]=m5_tmRing[i+1];}
    m5_hiRing[m5_ringSize-1]=newHi[0];m5_loRing[m5_ringSize-1]=newLo[0];m5_tmRing[m5_ringSize-1]=newTm[0];
    m5_ringHead=m5_ringSize-1;}

   int cur=m5_ringHead,pivot=cur-size;
   if(pivot<1)return;
   double hh=m5_hiRing[pivot+1],ll=m5_loRing[pivot+1];
   for(int k=pivot+2;k<=cur;k++){if(m5_hiRing[k]>hh)hh=m5_hiRing[k];if(m5_loRing[k]<ll)ll=m5_loRing[k];}
   bool nlh=m5_hiRing[pivot]>hh,nll=m5_loRing[pivot]<ll;
   int cLeg=m5_lastLeg;
   if(nlh)cLeg=0;else if(nll)cLeg=1;
   bool pL=(m5_lastLeg==0&&cLeg==1),pH=(m5_lastLeg==1&&cLeg==0);
   if(cLeg!=m5_lastLeg)m5_lastLeg=cLeg;

   if(pL)
   {
      m5_swingLowCur=m5_loRing[pivot];
      m5_swingLowCrossed=false;
      m5_swingLowTime=m5_tmRing[pivot];
      m5_trailBottom=m5_loRing[pivot];
      m5_trailBarTime=m5_tmRing[pivot];
      m5_lastBotTime=m5_tmRing[pivot];
      m5_swingHighCrossed=false;
      m5_bearSignalReady=false;
      m5_bearBreakCount=0;
      m5_bearSignalLocked=false;
   }
   if(pH)
   {
      m5_swingHighCur=m5_hiRing[pivot];
      m5_swingHighCrossed=false;
      m5_swingHighTime=m5_tmRing[pivot];
      m5_trailTop=m5_hiRing[pivot];
      m5_trailBarTime=m5_tmRing[pivot];
      m5_lastTopTime=m5_tmRing[pivot];
      m5_swingLowCrossed=false;
      m5_bullSignalReady=false;
      m5_bullBreakCount=0;
      m5_bullSignalLocked=false;
   }

   if(m5_hiRing[cur]>m5_trailTop){m5_trailTop=m5_hiRing[cur];m5_lastTopTime=m5_tmRing[cur];}
   if(m5_loRing[cur]<m5_trailBottom){m5_trailBottom=m5_loRing[cur];m5_lastBotTime=m5_tmRing[cur];}

   if(m5_swingHighCur!=EMPTY_VALUE&&m5_swingLowCur!=EMPTY_VALUE)
   {
      double clPrev[];ArrayResize(clPrev,1);ArraySetAsSeries(clPrev,false);
      if(CopyClose(_Symbol,M5_TF,2,1,clPrev)<1)return;
      if(newCl[0]>m5_swingHighCur&&clPrev[0]<=m5_swingHighCur&&!m5_swingHighCrossed)
      {m5_swingHighCrossed=true;m5_swingBias=1;ProcessM5BullBreak();}
      if(newCl[0]<m5_swingLowCur&&clPrev[0]>=m5_swingLowCur&&!m5_swingLowCrossed)
      {m5_swingLowCrossed=true;m5_swingBias=-1;ProcessM5BearBreak();}
   }
}

double N(double p){return NormalizeDouble(p,_Digits);}
double CalcSL(bool isBuy,int zone)
{
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK),bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double price=isBuy?ask:bid;
   if(UseManualSLTP) return isBuy?N(price-ManualSL_Points*_Point):N(price+ManualSL_Points*_Point);
   double bufPct=(zone==1)?EQ_SL_Buffer_Pct:GZ_SL_Buffer_Pct;
   double slBuf=bufPct/100.0;
   double zoneTop,zoneBot;
   if(zone==1){zoneTop=0.525*g_trailTop+0.475*g_trailBottom;zoneBot=0.525*g_trailBottom+0.475*g_trailTop;}
   else{bool bull=(g_swingBias==1);double l62=FiboPrice(g_trailTop,g_trailBottom,0.62,bull),l77=FiboPrice(g_trailTop,g_trailBottom,0.77,bull);
        zoneTop=MathMax(l62,l77);zoneBot=MathMin(l62,l77);}
   return isBuy?N(zoneBot*(1.0-slBuf)):N(zoneTop*(1.0+slBuf));
}
double CalcTP(double entry,double sl,int zone)
{
   if(UseManualSLTP){bool isBuy=(entry>sl);return isBuy?N(entry+ManualTP_Points*_Point):N(entry-ManualTP_Points*_Point);}
   double rr=(zone==1)?EQ_TP_RR:GZ_TP_RR;
   double risk=MathAbs(entry-sl);
   return(entry>sl)?N(entry+rr*risk):N(entry-rr*risk);
}
double CalcBE(double entry,bool isBuy)
{double pip=(_Digits==3||_Digits==5)?10.0*_Point:_Point;return isBuy?N(entry+BE_BufferPips*pip):N(entry-BE_BufferPips*pip);}

bool HasOpenPosition(int zone)
{
   for(int i=0;i<ArraySize(g_trades);i++)
      if(g_trades[i].zone==zone && PositionSelectByTicket(g_trades[i].ticket))
         return true;
   return false;
}
int CountTotalOpenPositions()
{
   int cnt=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);
      if(PositionSelectByTicket(t) &&
         PositionGetString(POSITION_SYMBOL)==_Symbol &&
         (int)PositionGetInteger(POSITION_MAGIC)==MagicNumber)
         cnt++;
   }
   return cnt;
}
bool HasAnyOpenPosition(){ return CountTotalOpenPositions()>0; }
void RegisterTrade(ulong ticket,double entry,double sl,double tp,bool isBuy,int zone)
{
   int idx=ArraySize(g_trades);ArrayResize(g_trades,idx+1);
   g_trades[idx].ticket=ticket;g_trades[idx].type=isBuy?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
   g_trades[idx].zone=zone;g_trades[idx].entryPrice=entry;g_trades[idx].sl=sl;g_trades[idx].tp=tp;
   g_trades[idx].beSet=false;g_trades[idx].trailSL=sl;
   Print("ZONA EA | ",isBuy?"BUY":"SELL"," Zone",(zone==1?"BR2":"BR1")," | Entry=",entry," SL=",sl," TP=",tp);
   SendSignalToWeb(isBuy,zone,entry,sl,tp,ticket);
}
void ModifySL(ulong ticket,double newSL)
{if(!PositionSelectByTicket(ticket))return;double curTP=PositionGetDouble(POSITION_TP);
 if(MathAbs(PositionGetDouble(POSITION_SL)-newSL)>_Point)trade.PositionModify(ticket,newSL,curTP);}
double GetRealizedPnL(){return AccountInfoDouble(ACCOUNT_BALANCE)-g_dayStartBalance;}

void SendSignalToWeb(bool isBuy,int zone,double entry,double sl,double tp,ulong ticket)
{
   if(!SendWebSignal) return;
   string zoneStr=(zone==1)?"BR2":"BR1";
   string json=StringFormat(
      "{\"symbol\":\"%s\",\"direction\":\"%s\",\"zone\":\"%s\",\"entry_price\":%.5f,"
      "\"sl\":%.5f,\"tp\":%.5f,\"lot\":%.2f,\"ticket\":%I64u,\"account_name\":\"%s\",\"magic\":%d}",
      _Symbol,isBuy?"BUY":"SELL",zoneStr,entry,sl,tp,(g_curLot>0?g_curLot:LotSize),ticket,SignalAccountLabel,MagicNumber);
   char post[],result[]; string headers;
   StringToCharArray(json,post,0,StringLen(json));
   string reqHeaders="Content-Type: application/json\r\nX-API-Key: "+SignalApiKey+"\r\n";
   int res=WebRequest("POST",SignalApiUrl,reqHeaders,5000,post,result,headers);
   if(res==-1) Print("ZONA EA | Gagal kirim sinyal. Error=",GetLastError());
}
string GetCloseReasonLabel(ulong posTicket)
{
   if(!HistorySelectByPosition(posTicket)) return "MANUAL";
   int total=HistoryDealsTotal();
   for(int i=total-1;i>=0;i--)
   {
      ulong dealTicket=HistoryDealGetTicket(i);
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket,DEAL_ENTRY)!=DEAL_ENTRY_OUT) continue;
      long reason=HistoryDealGetInteger(dealTicket,DEAL_REASON);
      double profit=HistoryDealGetDouble(dealTicket,DEAL_PROFIT);
      if(reason==DEAL_REASON_TP) return "TP_HIT";
      if(reason==DEAL_REASON_SL) return (profit>0)?"SL_PLUS_HIT":"SL_HIT";
      if(reason==DEAL_REASON_SO) return "STOPOUT";
      return "MANUAL";
   }
   return "MANUAL";
}
void SendCloseSignalToWeb(bool isBuy,int zone,ulong ticket)
{
   if(!SendWebSignal) return;
   string reason=GetCloseReasonLabel(ticket);
   string zoneStr=(zone==1)?"BR2":"BR1";
   string json=StringFormat(
      "{\"event_type\":\"CLOSE\",\"symbol\":\"%s\",\"direction\":\"%s\",\"zone\":\"%s\","
      "\"close_reason\":\"%s\",\"ticket\":%I64u,\"account_name\":\"%s\",\"magic\":%d}",
      _Symbol,isBuy?"BUY":"SELL",zoneStr,reason,ticket,SignalAccountLabel,MagicNumber);
   char post[],result[]; string headers;
   StringToCharArray(json,post,0,StringLen(json));
   string reqHeaders="Content-Type: application/json\r\nX-API-Key: "+SignalApiKey+"\r\n";
   WebRequest("POST",SignalApiUrl,reqHeaders,5000,post,result,headers);
}

bool IsTradeTime()
{
   if(!UseTradeTime) return true;
   MqlDateTime dt; TimeToStruct(TimeCurrent(),dt);
   int nowMin=dt.hour*60+dt.min;
   int startMin=TradeStartHour*60+TradeStartMinute;
   int endMin=TradeEndHour*60+TradeEndMinute;
   if(startMin<=endMin) return (nowMin>=startMin && nowMin<endMin);
   return (nowMin>=startMin || nowMin<endMin);
}

// DAY RECOVERY: di luar window trading (sudah lewat jam end), EA tetap boleh entry
// selama PnL realized HARI INI masih di bawah DayRecoveryTargetPnL.
// Daily profit target & daily loss limit tetap berlaku (g_dayDone).
bool IsDayRecoveryActive()
{
   if(!UseDayRecovery || !UseTradeTime) return false;
   if(IsTradeTime()) return false;                       // dalam window = normal, bukan mode recovery
   MqlDateTime dt; TimeToStruct(TimeCurrent(),dt);
   int nowMin=dt.hour*60+dt.min;
   int startMin=TradeStartHour*60+TradeStartMinute;
   int endMin=TradeEndHour*60+TradeEndMinute;
   if(startMin<=endMin && nowMin<startMin) return false; // belum sampai jam start, bukan "lewat jam end"
   return (GetRealizedPnL()<DayRecoveryTargetPnL);
}
datetime GetTodayDate(){MqlDateTime dt;TimeToStruct(TimeCurrent(),dt);dt.hour=0;dt.min=0;dt.sec=0;return StructToTime(dt);}
int CountDayClosedTrades()
{datetime dayStart=GetTodayDate();HistorySelect(dayStart,TimeCurrent());int cnt=0;
 for(int i=HistoryDealsTotal()-1;i>=0;i--){ulong d=HistoryDealGetTicket(i);
  if(HistoryDealGetString(d,DEAL_SYMBOL)!=_Symbol)continue;if((int)HistoryDealGetInteger(d,DEAL_MAGIC)!=MagicNumber)continue;
  if(HistoryDealGetInteger(d,DEAL_ENTRY)!=DEAL_ENTRY_OUT)continue;cnt++;}return cnt;}
void CheckDayReset()
{datetime today=GetTodayDate();if(today!=g_todayDate)
 {g_todayDate=today;g_dayStartBalance=AccountInfoDouble(ACCOUNT_BALANCE);g_dayDone=false;g_dayTradeCount=0;}}
bool CheckDailyLimits()
{if(g_dayDone)return false;double realPnL=GetRealizedPnL();
 if(UseDailyProfitTarget&&realPnL>=DailyProfitTarget){g_dayDone=true;return false;}
 if(UseDailyLossLimit&&realPnL<=-DailyLossLimit){g_dayDone=true;return false;}
 if(UseMaxTradesPerDay){g_dayTradeCount=CountDayClosedTrades();if(g_dayTradeCount>=MaxTradesPerDay){g_dayDone=true;return false;}}
 return true;}

void ManageTrades()
{
   double bid=SymbolInfoDouble(_Symbol,SYMBOL_BID),ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   double pip=(_Digits==3||_Digits==5)?10.0*_Point:_Point;
   for(int i=ArraySize(g_trades)-1;i>=0;i--)
   {
      ulong ticket=g_trades[i].ticket;
      if(!PositionSelectByTicket(ticket))
      {
         SendCloseSignalToWeb(g_trades[i].type==ORDER_TYPE_BUY,g_trades[i].zone,ticket);
         ArrayRemove(g_trades,i,1);
         continue;
      }
      bool isBuy=(g_trades[i].type==ORDER_TYPE_BUY);
      double price=isBuy?bid:ask;
      if(EnableBE&&!g_trades[i].beSet)
      {
         double profitPips=isBuy?(price-g_trades[i].entryPrice)/pip:(g_trades[i].entryPrice-price)/pip;
         if(profitPips>=BE_TriggerPips)
         {
            double be=CalcBE(g_trades[i].entryPrice,isBuy);ModifySL(ticket,be);
            g_trades[i].beSet=true;g_trades[i].trailSL=be;
            if(isBuy){if(g_trades[i].zone==1)g_eqBullEntryDone=true;if(g_trades[i].zone==2)g_gzBullEntryDone=true;
             if((!UseEQZone_Entry||g_eqBullEntryDone)&&(!UseGoldenZone_Entry||g_gzBullEntryDone)){g_bullSignalReady=false;g_bullSignalLocked=true;}}
            else{if(g_trades[i].zone==1)g_eqBearEntryDone=true;if(g_trades[i].zone==2)g_gzBearEntryDone=true;
             if((!UseEQZone_Entry||g_eqBearEntryDone)&&(!UseGoldenZone_Entry||g_gzBearEntryDone)){g_bearSignalReady=false;g_bearSignalLocked=true;}}
         }
      }
      if(EnableTrailing&&g_trades[i].beSet)
      {
         double distance=Trail_DistancePips*pip,step=Trail_StepPips*pip;
         if(isBuy){double newTSL=N(price-distance);if(newTSL>g_trades[i].trailSL+step){ModifySL(ticket,newTSL);g_trades[i].trailSL=newTSL;}}
         else{double newTSL=N(price+distance);if(newTSL<g_trades[i].trailSL-step){ModifySL(ticket,newTSL);g_trades[i].trailSL=newTSL;}}
      }
   }
}

// Hitung loss beruntun dari trade closed terakhir (magic + symbol ini).
// Berhenti di trade pertama yang tidak loss (profit+swap+komisi >= 0).
int CountConsecutiveLosses(bool force=false)
{
   if(!UseRecoveryLot) return 0;
   static datetime lastCalc=0; static int cached=0;
   if(!force && TimeLocal()-lastCalc<5) return cached;   // cache utk tampilan chart
   if(!HistorySelect(0,TimeCurrent())) return cached;
   lastCalc=TimeLocal();
   int losses=0;
   for(int i=HistoryDealsTotal()-1;i>=0;i--)
   {
      ulong d=HistoryDealGetTicket(i);
      if(HistoryDealGetString(d,DEAL_SYMBOL)!=_Symbol) continue;
      if((int)HistoryDealGetInteger(d,DEAL_MAGIC)!=MagicNumber) continue;
      if(HistoryDealGetInteger(d,DEAL_ENTRY)!=DEAL_ENTRY_OUT) continue;
      double net=HistoryDealGetDouble(d,DEAL_PROFIT)+HistoryDealGetDouble(d,DEAL_SWAP)+HistoryDealGetDouble(d,DEAL_COMMISSION);
      if(net<0) losses++; else break;
   }
   cached=losses;
   return losses;
}
double GetEntryLot(bool force=false)
{
   double lot=LotSize;
   if(UseRecoveryLot)
   {
      int steps=MathMin(CountConsecutiveLosses(force),RecoveryMaxSteps);
      if(steps>0) lot=LotSize*MathPow(RecoveryMultiplier,steps);
      lot=MathMin(lot,RecoveryMaxLot);
   }
   double minL=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxL=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double stp =SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(stp>0) lot=MathFloor(lot/stp+1e-9)*stp;
   return NormalizeDouble(MathMax(minL,MathMin(maxL,lot)),2);
}

bool OpenTrade(bool isBuy,int zone)
{
   // HARD LOCK: cegah re-entry pada tick yang sangat cepat/volatil
   if(g_entryBusy) return false;

   // Cek posisi REAL di terminal sebelum order
   if(HasOpenPosition(zone)) return false;
   if(CountTotalOpenPositions()>=MaxTotalPositions) return false;
   if(TimeCurrent()-g_lastEntryTime<EntryCooldownSec) return false;

   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK),bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double price=isBuy?ask:bid;
   double sl=CalcSL(isBuy,zone),tp=CalcTP(price,sl,zone);
   if(isBuy&&(sl>=price||tp<=price))return false;
   if(!isBuy&&(sl<=price||tp>=price))return false;

   // Lock SEBELUM mengirim order.
   g_entryBusy=true;

   string comment="ZONA"+(isBuy?" BUY ":" SELL ")+(zone==1?"BR2":"BR1");
   g_curLot=GetEntryLot(true);
   bool ok=isBuy?trade.Buy(g_curLot,_Symbol,price,sl,tp,comment):trade.Sell(g_curLot,_Symbol,price,sl,tp,comment);
   if(!ok)
   {
      g_entryBusy=false;
      return false;
   }

   // Beri terminal waktu singkat untuk memproses posisi.
   Sleep(100);

   // Setelah order sukses, cek posisi REAL sekali lagi.
   ulong ticket=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);
      if(PositionSelectByTicket(t) &&
         PositionGetString(POSITION_SYMBOL)==_Symbol &&
         (int)PositionGetInteger(POSITION_MAGIC)==MagicNumber)
      {
         // Cocokkan arah dan zone melalui comment.
         string posComment=PositionGetString(POSITION_COMMENT);
         bool dirOK=isBuy ? ((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)
                          : ((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_SELL);
         bool zoneOK=StringFind(posComment,(zone==1?"BR2":"BR1"))>=0;

         if(dirOK && zoneOK)
         {
            ticket=t;
            break;
         }
      }
   }

   // Fallback ke hasil transaksi broker.
   if(ticket==0) ticket=trade.ResultOrder();
   if(ticket==0) ticket=trade.ResultDeal();

   if(ticket>0)
   {
      RegisterTrade(ticket,price,sl,tp,isBuy,zone);
      g_lastEntryTime=TimeCurrent();

      // Tandai zona SEGERA di dalam OpenTrade.
      // Caller juga tetap mengeset flag sebagai proteksi tambahan.
      if(isBuy)
      {
         if(zone==1) g_eqBullEntryDone=true;
         else        g_gzBullEntryDone=true;
      }
      else
      {
         if(zone==1) g_eqBearEntryDone=true;
         else        g_gzBearEntryDone=true;
      }

      g_entryBusy=false;
      return true;
   }

   // Order sudah accepted tetapi ticket tidak ditemukan.
   // Jangan langsung mengizinkan entry kedua: cek posisi real terakhir.
   if(CountTotalOpenPositions()>0)
   {
      if(isBuy)
      {
         if(zone==1) g_eqBullEntryDone=true;
         else        g_gzBullEntryDone=true;
      }
      else
      {
         if(zone==1) g_eqBearEntryDone=true;
         else        g_gzBearEntryDone=true;
      }
      g_lastEntryTime=TimeCurrent();
      g_entryBusy=false;
      Print("ZONA EA | ORDER ACCEPTED tetapi ticket belum teridentifikasi -> ENTRY DI-LOCK");
      return true;
   }

   g_entryBusy=false;
   return false;
}

bool CheckExpired()
{
   datetime expireDate=StringToTime(EXPIRE_DATE);
   if(TimeCurrent()>=expireDate){g_isExpired=true;return true;}
   return false;
}
void ApplyStartupZoneFreshness(){}


//+------------------------------------------------------------------+
//| Kirim snapshot zona BR1/BR2 ke dashboard web setiap 60 detik     |
//+------------------------------------------------------------------+
string ZoneTimeframeLabel()
{
   string tf=EnumToString((ENUM_TIMEFRAMES)_Period);
   StringReplace(tf,"PERIOD_","");
   return tf;
}

string ZoneStatusLabel(bool touched,bool valid)
{
   if(!valid) return "INVALID";
   if(touched) return "USED";
   return "FRESH";
}

void SendZoneSnapshotToWeb(bool force=false)
{
   if(!SendZoneSnapshot || ZoneApiKey=="") return;
   if(g_trailTop<=g_trailBottom || g_trailBottom<=0) return;

   double br2Top=0.525*g_trailTop+0.475*g_trailBottom;
   double br2Bottom=0.525*g_trailBottom+0.475*g_trailTop;

   bool buyReady =(g_bullSignalReady && !g_bullSignalLocked);
   bool sellReady=(g_bearSignalReady && !g_bearSignalLocked);
   bool locked=(g_bullSignalLocked || g_bearSignalLocked);

   // Dashboard hanya boleh menampilkan zona setelah konfirmasi entry EA.
   bool confirmed=(buyReady || sellReady);
   bool bull=buyReady;
   double l62=FiboPrice(g_trailTop,g_trailBottom,0.62,bull);
   double l77=FiboPrice(g_trailTop,g_trailBottom,0.77,bull);
   double br1Top=MathMax(l62,l77);
   double br1Bottom=MathMin(l62,l77);

   string bias=buyReady?"BUY":sellReady?"SELL":"WAIT";
   string signalStatus=buyReady?"BUY_READY":sellReady?"SELL_READY":locked?"LOCKED":"WAITING";
   bool valid=(g_swingHighCur!=EMPTY_VALUE &&
               g_swingLowCur!=EMPTY_VALUE && confirmed);

   string statusBR1=ZoneStatusLabel(g_gzZoneTouched,valid);
   string statusBR2=ZoneStatusLabel(g_eqZoneTouched,valid);
   string tf=ZoneTimeframeLabel();

   // Kirim segera ketika status konfirmasi atau batas zona berubah.
   // Jika tidak berubah, snapshot tetap diperbarui setiap 60 detik.
   string snapshotState=StringFormat("%s|%s|%s|%s|%s|%s|%s",
      _Symbol,tf,signalStatus,
      DoubleToString(g_trailTop,_Digits),
      DoubleToString(g_trailBottom,_Digits),
      statusBR1,statusBR2);
   if(!force && snapshotState==g_lastZoneSnapshotState &&
      g_lastZoneSnapshotTime>0 &&
      (TimeCurrent()-g_lastZoneSnapshotTime)<60)
      return;

   string br1=StringFormat("{\"top\":%s,\"bottom\":%s}",
      DoubleToString(br1Top,_Digits),DoubleToString(br1Bottom,_Digits));
   string br2=StringFormat("{\"top\":%s,\"bottom\":%s}",
      DoubleToString(br2Top,_Digits),DoubleToString(br2Bottom,_Digits));
   string json=StringFormat(
      "{\"symbol\":\"%s\",\"zones\":[{\"tf\":\"%s\",\"bias\":\"%s\","
      "\"signal_status\":\"%s\",\"confirmed\":%s,"
      "\"swing_top\":%s,\"swing_bottom\":%s,\"swing_pts\":%s,"
      "\"status_br1\":\"%s\",\"status_br2\":\"%s\",\"br1\":%s,\"br2\":%s}]}",
      _Symbol,tf,bias,signalStatus,confirmed?"true":"false",
      DoubleToString(g_trailTop,_Digits),
      DoubleToString(g_trailBottom,_Digits),
      DoubleToString((g_trailTop-g_trailBottom)/_Point,1),
      statusBR1,statusBR2,br1,br2
   );

   char post[],result[];
   string responseHeaders;
   StringToCharArray(json,post,0,WHOLE_ARRAY,CP_UTF8);
   if(ArraySize(post)>0) ArrayResize(post,ArraySize(post)-1);
   string headers="Content-Type: application/json\r\nX-API-Key: "+ZoneApiKey+"\r\n";
   ResetLastError();
   g_lastZoneSnapshotTime=TimeCurrent(); // throttle juga saat request gagal
   g_lastZoneSnapshotState=snapshotState;
   int code=WebRequest("POST",ZoneApiUrl,headers,5000,post,result,responseHeaders);
   if(code==200)
   {
      Print("ZONA WEB | Snapshot terkirim: ",_Symbol," ",tf,
            " | ",signalStatus," | HTTP ",code);
   }
   else
   {
      Print("ZONA WEB | Gagal kirim snapshot. HTTP=",code,
            " Error=",GetLastError()," | ",CharArrayToString(result));
   }
}

// Kirim event saat harga pertama kali masuk BR1/BR2.
// Event ini terpisah dari snapshot dan tidak menunggu Cron Worker.
void SendZoneTriggerToWeb(double bidNow,double askNow)
{
   if(!SendZoneTrigger || ZoneApiKey=="") return;
   if(g_trailTop<=g_trailBottom || g_trailBottom<=0) return;

   bool buyReady =(g_bullSignalReady && !g_bullSignalLocked);
   bool sellReady=(g_bearSignalReady && !g_bearSignalLocked);
   if(!buyReady && !sellReady) return;

   bool bull=buyReady;
   string bias=bull?"BUY":"SELL";
   string tf=ZoneTimeframeLabel();
   double livePrice=bull?askNow:bidNow;
   if(livePrice<=0) return;

   double br2Top=0,br2Bottom=0,br1Top=0,br1Bottom=0;
   GetEQBounds(br2Top,br2Bottom);
   GetGZBounds(br1Top,br1Bottom,bull);

   // Hanya zona yang diaktifkan pada pengaturan entry EA yang mengirim alert.
   if(UseGoldenZone_Entry && !g_gzZoneTouched)
   {
      bool insideBR1=(livePrice>=br1Bottom && livePrice<=br1Top);
      if(UseMaxZoneRange && (br1Top-br1Bottom)/_Point>MaxZoneRangePips) insideBR1=false;
      string key1=StringFormat("%s|%s|%s|%s|%s",_Symbol,tf,bias,
                    DoubleToString(br1Bottom,_Digits),DoubleToString(br1Top,_Digits));
      if(insideBR1 && key1!=g_lastZoneTriggerBR1 &&
         (g_lastZoneTriggerAttemptBR1==0 || TimeCurrent()-g_lastZoneTriggerAttemptBR1>=5))
      {
         g_lastZoneTriggerAttemptBR1=TimeCurrent();
         string payload=StringFormat(
            "{\"symbol\":\"%s\",\"tf\":\"%s\",\"bias\":\"%s\",\"block\":\"BR1\","
            "\"top\":%s,\"bottom\":%s,\"price\":%s}",
            _Symbol,tf,bias,DoubleToString(br1Top,_Digits),
            DoubleToString(br1Bottom,_Digits),DoubleToString(livePrice,_Digits));
         char post[],result[]; string responseHeaders;
         StringToCharArray(payload,post,0,WHOLE_ARRAY,CP_UTF8);
         if(ArraySize(post)>0) ArrayResize(post,ArraySize(post)-1);
         string headers="Content-Type: application/json\r\nX-API-Key: "+ZoneApiKey+"\r\n";
         ResetLastError();
         int code=WebRequest("POST",ZoneApiUrl+"/trigger",headers,3000,post,result,responseHeaders);
         if(code==200)
         {
            g_lastZoneTriggerBR1=key1;
            Print("ZONA WEB | BR1 trigger terkirim | ",bias," ",tf," | ",DoubleToString(livePrice,_Digits));
         }
         else
            Print("ZONA WEB | BR1 trigger gagal. HTTP=",code," Error=",GetLastError()," | ",CharArrayToString(result));
      }
      if(!insideBR1) g_lastZoneTriggerBR1="";
   }

   if(UseEQZone_Entry && !g_eqZoneTouched)
   {
      bool insideBR2=(livePrice>=br2Bottom && livePrice<=br2Top);
      if(UseMaxZoneRange && (br2Top-br2Bottom)/_Point>MaxZoneRangePips) insideBR2=false;
      string key2=StringFormat("%s|%s|%s|%s|%s",_Symbol,tf,bias,
                    DoubleToString(br2Bottom,_Digits),DoubleToString(br2Top,_Digits));
      if(insideBR2 && key2!=g_lastZoneTriggerBR2 &&
         (g_lastZoneTriggerAttemptBR2==0 || TimeCurrent()-g_lastZoneTriggerAttemptBR2>=5))
      {
         g_lastZoneTriggerAttemptBR2=TimeCurrent();
         string payload=StringFormat(
            "{\"symbol\":\"%s\",\"tf\":\"%s\",\"bias\":\"%s\",\"block\":\"BR2\","
            "\"top\":%s,\"bottom\":%s,\"price\":%s}",
            _Symbol,tf,bias,DoubleToString(br2Top,_Digits),
            DoubleToString(br2Bottom,_Digits),DoubleToString(livePrice,_Digits));
         char post[],result[]; string responseHeaders;
         StringToCharArray(payload,post,0,WHOLE_ARRAY,CP_UTF8);
         if(ArraySize(post)>0) ArrayResize(post,ArraySize(post)-1);
         string headers="Content-Type: application/json\r\nX-API-Key: "+ZoneApiKey+"\r\n";
         ResetLastError();
         int code=WebRequest("POST",ZoneApiUrl+"/trigger",headers,3000,post,result,responseHeaders);
         if(code==200)
         {
            g_lastZoneTriggerBR2=key2;
            Print("ZONA WEB | BR2 trigger terkirim | ",bias," ",tf," | ",DoubleToString(livePrice,_Digits));
         }
         else
            Print("ZONA WEB | BR2 trigger gagal. HTTP=",code," Error=",GetLastError()," | ",CharArrayToString(result));
      }
      if(!insideBR2) g_lastZoneTriggerBR2="";
   }
}

int OnInit()
{
   g_isVisual=(MQLInfoInteger(MQL_TESTER)==0)||(MQLInfoInteger(MQL_VISUAL_MODE)==1);
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(Slippage);
   trade.SetTypeFilling(ORDER_FILLING_IOC);

   if(UseEMAFilter)
   {
      g_emaFastHandle=iMA(_Symbol,EMA_TF,EMA_Fast,0,MODE_EMA,PRICE_CLOSE);
      g_emaMidHandle=iMA(_Symbol,EMA_TF,EMA_Mid,0,MODE_EMA,PRICE_CLOSE);
      g_emaSlowHandle=iMA(_Symbol,EMA_TF,EMA_Slow,0,MODE_EMA,PRICE_CLOSE);
      g_emaTrendHandle=iMA(_Symbol,EMA_TF,EMA_Trend,0,MODE_EMA,PRICE_CLOSE);
      if(g_emaFastHandle==INVALID_HANDLE||g_emaMidHandle==INVALID_HANDLE||
         g_emaSlowHandle==INVALID_HANDLE||g_emaTrendHandle==INVALID_HANDLE)
         return INIT_FAILED;
   }

   if(ConfirmMode==CONF_RSI)
   {
      g_rsiHandle=iRSI(_Symbol,PERIOD_CURRENT,RSI_Period,PRICE_CLOSE);
      if(g_rsiHandle==INVALID_HANDLE) return INIT_FAILED;
   }

   ArrayResize(g_trades,0); g_ringSize=0; m5_ringSize=0;
   g_todayDate=GetTodayDate(); g_dayStartBalance=AccountInfoDouble(ACCOUNT_BALANCE);
   g_dayDone=false; g_dayTradeCount=CountDayClosedTrades();
   g_lastEntryTime=0;
   g_entryBusy=false;

   FullScan();
   FullScanM5();
   g_lastBarTime=iTime(_Symbol,PERIOD_CURRENT,0);
   m5_lastBarTime=iTime(_Symbol,M5_TF,0);
   g_bullSignalLocked=false; g_bearSignalLocked=false;
   g_eqBullEntryDone=false; g_eqBearEntryDone=false;
   g_gzBullEntryDone=false; g_gzBearEntryDone=false;
   g_eqZoneTouched=false; g_gzZoneTouched=false;
    g_eqBuyZoneSeen=false; g_eqSellZoneSeen=false; g_gzBuyZoneSeen=false; g_gzSellZoneSeen=false;
    g_eqBuyOSSeen=false; g_eqSellOBSeen=false; g_gzBuyOSSeen=false; g_gzSellOBSeen=false;
   g_swingHighCrossed=false; g_swingLowCrossed=false;
   Print("ZONA EA v7.26 ready | ZONE ONLY | candle-close break | direct zone push | M5 filter=",UseM5Filter," | 4EMA=",UseEMAFilter," | DayRecovery=",UseDayRecovery);
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason)
{
   if(g_emaFastHandle!=INVALID_HANDLE) IndicatorRelease(g_emaFastHandle);
   if(g_emaMidHandle!=INVALID_HANDLE) IndicatorRelease(g_emaMidHandle);
   if(g_emaSlowHandle!=INVALID_HANDLE) IndicatorRelease(g_emaSlowHandle);
   if(g_emaTrendHandle!=INVALID_HANDLE) IndicatorRelease(g_emaTrendHandle);
   if(g_rsiHandle!=INVALID_HANDLE) IndicatorRelease(g_rsiHandle);
   if(g_isVisual){DelAll();ChartRedraw();}
}

void OnTick()
{
   if(g_isExpired||CheckExpired()) return;
   ManageTrades();
   SendZoneSnapshotToWeb();

   datetime curBarTime=iTime(_Symbol,PERIOD_CURRENT,0);
   if(curBarTime!=g_lastBarTime){g_lastBarTime=curBarTime;IncrementalUpdate();}

   datetime m5BarTime=iTime(_Symbol,M5_TF,0);
   if(UseM5Filter && m5BarTime!=m5_lastBarTime){m5_lastBarTime=m5BarTime;IncrementalUpdateM5();}

   UpdateEMA();
   CheckDayReset();

   double bidNow=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double askNow=SymbolInfoDouble(_Symbol,SYMBOL_ASK);

   // Alert sentuhan zona berjalan setiap tick dan tidak bergantung pada jam trading/limit entry.
   SendZoneTriggerToWeb(bidNow,askNow);

   if(!CheckDailyLimits()) return;

   // v7.19: di luar window trading tetap lanjut kalau mode DAY RECOVERY aktif
   if(!IsTradeTime() && !IsDayRecoveryActive()) return;

   if(g_eqBullEntryDone||g_eqBearEntryDone) g_eqZoneTouched=true;
   if(g_gzBullEntryDone||g_gzBearEntryDone) g_gzZoneTouched=true;

   if(g_bullSignalReady&&!g_bullSignalLocked&&M5AllowBuy()&&EMAAllowBuy())
   {
      if(UseEQZone_Entry&&!g_eqBullEntryDone&&EQEntryOK(askNow,true))
         if(OpenTrade(true,1)) g_eqBullEntryDone=true;
      if(UseGoldenZone_Entry&&!g_gzBullEntryDone&&GZEntryOK(askNow,true))
         if(OpenTrade(true,2)) g_gzBullEntryDone=true;
   }
   if(g_bearSignalReady&&!g_bearSignalLocked&&M5AllowSell()&&EMAAllowSell())
   {
      if(UseEQZone_Entry&&!g_eqBearEntryDone&&EQEntryOK(bidNow,false))
         if(OpenTrade(false,1)) g_eqBearEntryDone=true;
      if(UseGoldenZone_Entry&&!g_gzBearEntryDone&&GZEntryOK(bidNow,false))
         if(OpenTrade(false,2)) g_gzBearEntryDone=true;
   }
}
//+------------------------------------------------------------------+