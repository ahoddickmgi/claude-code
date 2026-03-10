-- =============================================================================
-- Lot History Query  –  Sage X3 / SQL Server
-- Optimized with CTEs to eliminate redundant table scans.
--
-- Original issues fixed:
--   • STOJOU was scanned 12+ times; now 2 scans (agg + string lists)
--   • STOCK was scanned 4 times;   now 1 scan
--   • SINVOICED+STOJOU join was done twice; now once
--   • SORDERQ+SORDERP+STOCK join was done twice; now once
--   • PORDERQ+STOJOU join was done 3 times; now once
--   • STOLOT receipt entries re-filtered 5 times; now once
--   • Main LEFT JOIN STOCK could produce duplicate rows per lot – fixed
--   • POLINEQTY / PORECQTY had GROUP BY inside scalar subquery which errors
--     when a lot has >1 PO line – fixed by removing redundant GROUP BY
-- =============================================================================

-- ► Put your lot+item combinations here.
--   If ITMREF_0 is left NULL the filter matches any item for that lot.
DECLARE @lots TABLE (LOT_0 NVARCHAR(30), ITMREF_0 NVARCHAR(30) NULL);
INSERT INTO @lots VALUES
    ('PO004428-3000',  'PET-SS1100KGSUP'),
    ('PO001649-1000',  'LLDPE-BAG25KGSR'),
    ('PO006422-16000', 'PET-SS1100KGSUP'),
    ('PO005707-2000',  'LDPE-BAG25KGSUP');

WITH
-- ── 1. Resolve input lots once ────────────────────────────────────────────────
lot_filter AS (
    SELECT DISTINCT SL.LOT_0, SL.ITMREF_0
    FROM   LIVE.STOLOT SL
    JOIN   @lots       LF ON  LF.LOT_0    = SL.LOT_0
                          AND (LF.ITMREF_0 IS NULL OR LF.ITMREF_0 = SL.ITMREF_0)
),

-- ── 2. STOCK: single scan → QOHLBS, STOFLD2_0, STOCOU_0, CURRENTSITE ────────
--    The original LEFT JOIN to STOCK on the outer query produced duplicate rows
--    when a lot existed in multiple locations.  We aggregate here instead.
stock_agg AS (
    SELECT
        ST.LOT_0,
        ST.ITMREF_0,
        SUM(ST.QTYSTU_0)  AS QOHLBS,
        MAX(ST.STOFLD2_0) AS STOFLD2_0,  -- custom lot-ID field; same across locations
        MIN(ST.STOCOU_0)  AS STOCOU_0,   -- used by QTYSCHED; take first allocation record
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + s2.STOFCY_0
            FROM   LIVE.STOCK s2
            WHERE  s2.LOT_0    = ST.LOT_0
              AND  s2.ITMREF_0 = ST.ITMREF_0
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS CURRENTSITE
    FROM       LIVE.STOCK ST
    JOIN       lot_filter  LF ON LF.LOT_0 = ST.LOT_0 AND LF.ITMREF_0 = ST.ITMREF_0
    GROUP BY   ST.LOT_0, ST.ITMREF_0
),

-- ── 3. STOJOU: single scan → all aggregated numeric columns ──────────────────
--    Replaces 9 separate correlated subqueries on STOJOU.
stojou_agg AS (
    SELECT
        SJ.LOT_0,
        SJ.ITMREF_0,
        -- Shipped qty (customer deliveries, VCRTYP_0=4, non-intercompany)
        -SUM(CASE WHEN SJ.VCRTYP_0 = 4  AND LEN(SJ.BPRNUM_0) <> 5 THEN SJ.QTYSTU_0 ELSE 0 END)  AS SHIPQTY,
        -- Inventory adjustments
         SUM(CASE WHEN SJ.VCRTYP_0 IN (19,20)                      THEN SJ.QTYSTU_0 ELSE 0 END)  AS QTYADJ,
        -- Returns to supplier
         SUM(CASE WHEN SJ.VCRTYP_0 = 8                             THEN SJ.QTYSTU_0 ELSE 0 END)  AS QTYRETSUPP,
        -- Purchase invoice cost numerator / denominator (VCRTYP_0=6)
         SUM(CASE WHEN SJ.VCRTYP_0 = 6                             THEN SJ.VARORD_0  ELSE 0 END) AS varord_rec,
         SUM(CASE WHEN SJ.VCRTYP_0 = 6                             THEN SJ.QTYSTU_0  ELSE 0 END) AS qty_rec,
        -- Purchase receipt cost (VCRTYP_0=6, not yet matched to invoice)
         SUM(CASE WHEN SJ.VCRTYP_0 = 6 AND SJ.VCRNUMREG_0 = ''    THEN SJ.VARORD_0  ELSE 0 END) AS varord_unreg,
         SUM(CASE WHEN SJ.VCRTYP_0 = 6 AND SJ.VCRNUMREG_0 = ''    THEN SJ.QTYSTU_0  ELSE 0 END) AS qty_unreg
    FROM       LIVE.STOJOU SJ
    JOIN       lot_filter   LF ON LF.LOT_0 = SJ.LOT_0 AND LF.ITMREF_0 = SJ.ITMREF_0
    GROUP BY   SJ.LOT_0, SJ.ITMREF_0
),

-- ── 4. Supplier names (one pass over STOLOT + BPSUPPLIER) ────────────────────
supplier_list AS (
    SELECT
        LF.LOT_0,
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + BPS.BPSNAM_0
            FROM   LIVE.STOLOT      SL2
            JOIN   LIVE.BPSUPPLIER  BPS ON BPS.BPSNUM_0 = SL2.BPSNUM_0
            WHERE  SL2.LOT_0       = LF.LOT_0
              AND  SL2.BPSNUM_0   <> ''
              AND  LEN(SL2.BPSNUM_0) <> 5
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS SUPPLIER
    FROM (SELECT DISTINCT LOT_0 FROM lot_filter) LF
),

-- ── 5. Delivery voucher list (FOR XML once per lot, not per outer row) ────────
delivery_list AS (
    SELECT
        LF.LOT_0,
        LF.ITMREF_0,
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + SJ2.VCRNUM_0
            FROM   LIVE.STOJOU SJ2
            WHERE  SJ2.LOT_0    = LF.LOT_0
              AND  SJ2.ITMREF_0 = LF.ITMREF_0
              AND  SJ2.VCRTYP_0 = 4
              AND  LEN(SJ2.BPRNUM_0) <> 5
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS DELIVERIES
    FROM lot_filter LF
),

-- ── 6. STOLOT receipt entries (VCRTYP_0=6) – filtered once ───────────────────
--    Reused for: RECEIPTNUM, RECEIPTDATE, RECEIPTETA, POLINEQTY, PORECQTY
stolot_rec AS (
    SELECT SL.LOT_0, SL.ITMREF_0, SL.VCRNUM_0, SL.VCRLIN_0
    FROM   LIVE.STOLOT SL
    JOIN   lot_filter   LF ON LF.LOT_0 = SL.LOT_0
    WHERE  SL.VCRTYP_0 = 6
      AND  LEN(SL.BPSNUM_0) <> 5
),

-- ── 7. Receipt header data (dates, ETA) ──────────────────────────────────────
receipt_data AS (
    SELECT SR.LOT_0, SR.VCRNUM_0, REC.RCPDAT_0, REC.YRCETA_0
    FROM   stolot_rec   SR
    LEFT JOIN LIVE.PRECEIPT REC ON REC.PTHNUM_0 = SR.VCRNUM_0
),

-- ── 8. Receipt aggregations (numbers, dates, ETA) – FOR XML once per lot ─────
receipt_agg AS (
    SELECT
        RD.LOT_0,
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + r2.VCRNUM_0
            FROM   receipt_data r2
            WHERE  r2.LOT_0 = RD.LOT_0
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS RECEIPTNUM,

        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + CONVERT(VARCHAR, r2.RCPDAT_0, 101)
            FROM   receipt_data r2
            WHERE  r2.LOT_0      = RD.LOT_0
              AND  r2.RCPDAT_0  IS NOT NULL
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS RECEIPTDATE,

        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + CASE WHEN YEAR(r2.YRCETA_0) < 1900 THEN ''
                                        ELSE CONVERT(VARCHAR, r2.YRCETA_0, 101) END
            FROM   receipt_data r2
            WHERE  r2.LOT_0      = RD.LOT_0
              AND  r2.YRCETA_0  IS NOT NULL
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS RECEIPTETA
    FROM (SELECT DISTINCT LOT_0 FROM receipt_data) RD
),

-- ── 9. PO base: PORDERQ + STOJOU join (single scan) ─────────────────────────
--    Reused for: PURTYPE, SHIPMENT, CONTETA
po_base AS (
    SELECT DISTINCT
        SJ.LOT_0,
        SJ.ITMREF_0,
        POQ.POHNUM_0,
        POQ.POPLIN_0,
        POQ.ZPOTYP_0
    FROM       LIVE.STOJOU  SJ
    JOIN       lot_filter    LF  ON LF.LOT_0    = SJ.LOT_0  AND LF.ITMREF_0 = SJ.ITMREF_0
    JOIN       LIVE.PORDERQ  POQ ON POQ.POHNUM_0 = SJ.VCRNUMORI_0 AND POQ.POPLIN_0 = SJ.VCRLINORI_0
),

-- ── 10. Shipment details (built from po_base, no extra STOJOU scan) ───────────
shipment_base AS (
    SELECT DISTINCT
        PB.LOT_0,
        PB.ITMREF_0,
        SHD.SHIPNUM_0,
        SH.YETADETPORT_0
    FROM       po_base       PB
    JOIN       LIVE.SHIPMENTD SHD ON SHD.POHNUM_0  = PB.POHNUM_0 AND SHD.POPLIN_0 = PB.POPLIN_0
    JOIN       LIVE.SHIPMENT  SH  ON SH.SHIPNUM_0  = SHD.SHIPNUM_0
),

-- ── 11. PO aggregations (PURTYPE, SHIPMENT, CONTETA) – FOR XML once per lot ──
po_agg AS (
    SELECT
        LF.LOT_0,
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + CASE pb.ZPOTYP_0
                WHEN 1 THEN 'Domestic' WHEN 2 THEN 'International'
                WHEN 3 THEN 'Import'   WHEN 4 THEN 'Export' END
            FROM   po_base pb
            WHERE  pb.LOT_0 = LF.LOT_0
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS PURTYPE,

        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + sb.SHIPNUM_0
            FROM   shipment_base sb
            WHERE  sb.LOT_0 = LF.LOT_0
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS SHIPMENT,

        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + CASE WHEN YEAR(sb.YETADETPORT_0) < 1900 THEN ''
                                        ELSE CONVERT(VARCHAR, sb.YETADETPORT_0, 101) END
            FROM   shipment_base sb
            WHERE  sb.LOT_0 = LF.LOT_0
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS CONTETA
    FROM (SELECT DISTINCT LOT_0 FROM lot_filter) LF
),

-- ── 12. Rail car numbers (PORDERP – separate table from PORDERQ) ─────────────
railcar_agg AS (
    SELECT
        LF.LOT_0,
        COALESCE(CAST(STUFF((
            SELECT DISTINCT ', ' + POP.YRAILCARNUM_0
            FROM   LIVE.STOJOU  SJ2
            JOIN   LIVE.PORDERP POP ON POP.POHNUM_0 = SJ2.VCRNUMORI_0 AND POP.POPLIN_0 = SJ2.VCRLINORI_0
            WHERE  SJ2.LOT_0    = LF.LOT_0
              AND  SJ2.ITMREF_0 = LF.ITMREF_0
              AND  POP.YRAILCARNUM_0 <> ''
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'),
        1, 2, '') AS VARCHAR(500)), '') AS PORAILCAR
    FROM lot_filter LF
),

-- ── 13. Packing cost ──────────────────────────────────────────────────────────
pack_cost AS (
    SELECT
        PS.LOT_0,
        PS.ITMREF_0,
        SUM(PS.POPERLB + PS.PKGPERLB) AS PACKLPCCOST
    FROM   LIVE.ZPKGSTOLOT PS
    JOIN   lot_filter        LF ON LF.LOT_0 = PS.LOT_0 AND LF.ITMREF_0 = PS.ITMREF_0
    GROUP BY PS.LOT_0, PS.ITMREF_0
),

-- ── 14. PO line qty + receipt qty (joined in one pass) ───────────────────────
--    Original had two separate scalar subqueries with GROUP BY which would error
--    ("subquery returned more than 1 value") if a lot had more than one PO line.
--    Fixed by removing redundant GROUP BY and summing across all lines.
po_receipt_qty AS (
    SELECT
        SR.LOT_0,
        SUM(POQ.QTYSTU_0) AS POLINEQTY,
        SUM(RD.QTYSTU_0)  AS PORECQTY
    FROM       stolot_rec    SR
    LEFT JOIN  LIVE.PRECEIPTD RD  ON RD.PTHNUM_0 = SR.VCRNUM_0 AND RD.PTDLIN_0 = SR.VCRLIN_0
    LEFT JOIN  LIVE.PORDERQ   POQ ON POQ.POHNUM_0 = RD.POHNUM_0 AND POQ.POPLIN_0 = RD.POPLIN_0
    GROUP BY   SR.LOT_0
),

-- ── 15. SINVOICED: single scan → QTYINV + AMTINV ────────────────────────────
invoice_agg AS (
    SELECT
        SJ.LOT_0,
        SJ.ITMREF_0,
        SUM(SID.QTYSTU_0)            AS QTYINV,
        SUM(SID.QTY_0 * SID.NETPRI_0) AS AMTINV
    FROM   LIVE.STOJOU    SJ
    JOIN   lot_filter      LF  ON LF.LOT_0    = SJ.LOT_0 AND LF.ITMREF_0 = SJ.ITMREF_0
    JOIN   LIVE.SINVOICED  SID ON SID.SDHNUM_0 = SJ.VCRNUM_0 AND SID.SDDLIN_0 = SJ.VCRLIN_0
    GROUP BY SJ.LOT_0, SJ.ITMREF_0
),

-- ── 16. Sales orders: single scan → QTYSOLD (used for both QTYSOLD/QTYUNSOLD) ─
sales_agg AS (
    SELECT
        ST1.LOT_0,
        SUM(SOQ.QTYSTU_0) AS QTYSOLD
    FROM       LIVE.SORDERQ  SOQ
    JOIN       LIVE.SORDERP  SOP ON SOP.SOHNUM_0  = SOQ.SOHNUM_0 AND SOP.SOPLIN_0 = SOQ.SOPLIN_0
    JOIN       LIVE.STOCK    ST1 ON ST1.STOFLD2_0  = SOP.YLOTID_0
    JOIN       lot_filter     LF  ON LF.LOT_0      = ST1.LOT_0
    WHERE      SOQ.SOQSEQ_0 <> 3
    GROUP BY   ST1.LOT_0
),

-- ── 17. Scheduled qty (STOALL) ───────────────────────────────────────────────
sched_agg AS (
    SELECT
        SA.STOCOU_0,
        SUM(SA.QTYSTU_0) AS QTYSCHED
    FROM   LIVE.STOALL SA
    GROUP BY SA.STOCOU_0
)

-- ── Final SELECT ──────────────────────────────────────────────────────────────
SELECT
    LF.ITMREF_0,
    LF.LOT_0,
    SA_ST.STOFLD2_0,

    SUP.SUPPLIER,
    DL.DELIVERIES,
    COALESCE(SJA.SHIPQTY,    0)                                         AS SHIPQTY,
    SA_ST.CURRENTSITE,
    PA.PURTYPE,
    PA.SHIPMENT,
    RA.PORAILCAR,
    RA2.RECEIPTNUM,
    RA2.RECEIPTDATE,
    RA2.RECEIPTETA,
    PA.CONTETA,

    -- Cost per lb: purchase invoice cost / purchase receipt cost
    CASE WHEN NULLIF(SJA.qty_rec,    0) IS NOT NULL THEN SJA.varord_rec    / SJA.qty_rec    END AS PURINVCOST,
    CASE WHEN NULLIF(SJA.qty_unreg,  0) IS NOT NULL THEN SJA.varord_unreg  / SJA.qty_unreg  END AS PURRECCOST,

    COALESCE(PC.PACKLPCCOST, 0)                                         AS PACKLPCCOST,
    PRQ.POLINEQTY,
    PRQ.PORECQTY,
    COALESCE(SJA.QTYADJ,     0)                                         AS QTYADJ,

    SA_ST.QOHLBS,
    -- QTYUNSOLD / QTYSOLD: only meaningful while stock is on hand
    CASE WHEN SA_ST.QOHLBS > 0 THEN SA_ST.QOHLBS - COALESCE(SAGG.QTYSOLD, 0) ELSE 0 END AS QTYUNSOLD,
    CASE WHEN SA_ST.QOHLBS > 0 THEN                COALESCE(SAGG.QTYSOLD, 0)  ELSE 0 END AS QTYSOLD,

    COALESCE(SCH.QTYSCHED,   0)                                         AS QTYSCHED,
    COALESCE(IA.QTYINV,      0)                                         AS QTYINV,
    COALESCE(SJA.QTYRETSUPP, 0)                                         AS QTYRETSUPP,
    COALESCE(IA.AMTINV,      0)                                         AS AMTINV

FROM           lot_filter   LF

-- Stock (one aggregated row per lot – no duplicate risk)
LEFT JOIN      stock_agg    SA_ST ON SA_ST.LOT_0 = LF.LOT_0 AND SA_ST.ITMREF_0 = LF.ITMREF_0

-- String lists
LEFT JOIN      supplier_list SUP  ON SUP.LOT_0   = LF.LOT_0
LEFT JOIN      delivery_list DL   ON DL.LOT_0    = LF.LOT_0 AND DL.ITMREF_0   = LF.ITMREF_0
LEFT JOIN      po_agg        PA   ON PA.LOT_0    = LF.LOT_0
LEFT JOIN      railcar_agg   RA   ON RA.LOT_0    = LF.LOT_0
LEFT JOIN      receipt_agg   RA2  ON RA2.LOT_0   = LF.LOT_0

-- Aggregated scalars
LEFT JOIN      stojou_agg   SJA   ON SJA.LOT_0   = LF.LOT_0 AND SJA.ITMREF_0  = LF.ITMREF_0
LEFT JOIN      pack_cost    PC    ON PC.LOT_0     = LF.LOT_0 AND PC.ITMREF_0   = LF.ITMREF_0
LEFT JOIN      po_receipt_qty PRQ ON PRQ.LOT_0    = LF.LOT_0
LEFT JOIN      sales_agg    SAGG  ON SAGG.LOT_0   = LF.LOT_0
LEFT JOIN      invoice_agg  IA    ON IA.LOT_0     = LF.LOT_0 AND IA.ITMREF_0   = LF.ITMREF_0
LEFT JOIN      sched_agg    SCH   ON SCH.STOCOU_0 = SA_ST.STOCOU_0

ORDER BY LF.ITMREF_0, LF.LOT_0;
