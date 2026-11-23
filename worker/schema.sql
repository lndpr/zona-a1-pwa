CREATE TABLE IF NOT EXISTS signals (

  id INTEGER PRIMARY KEY AUTOINCREMENT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  symbol TEXT NOT NULL,

  direction TEXT NOT NULL,
  -- BUY / SELL

  zone TEXT NOT NULL,
  -- BR1 / BR2


  entry_price REAL,

  sl REAL,

  tp REAL,

  lot REAL,


  status TEXT NOT NULL DEFAULT 'RUNNING',
  -- RUNNING / CLOSED


  result TEXT,
  -- WIN / LOSS


  close_reason TEXT,
  -- TP_HIT / SL_HIT / SL_PLUS_HIT / STOPOUT / MANUAL


  closed_at TEXT,


  profit REAL,
  -- profit bersih posisi (profit+swap+komisi), dikirim EA saat CLOSE


  ticket INTEGER,
  -- nomor posisi MT5 penghubung OPEN-CLOSE


  account_name TEXT,


  magic INTEGER

);


CREATE INDEX IF NOT EXISTS idx_signals_created_at 
ON signals(created_at DESC);


CREATE INDEX IF NOT EXISTS idx_signals_ticket
ON signals(ticket);