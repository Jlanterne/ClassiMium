def refresh_moyennes_if_needed(db_conn_factory, max_age_minutes=5):
    """
    Rafraîchit eleve_moyennes_mv si marquée 'dirty' ou trop ancienne.
    Ne fait jamais planter l'API : ignore si mview/flags absents, et
    bascule en refresh non-concurrent si nécessaire.
    """
    # Lire le flag
    try:
        conn = db_conn_factory(); cur = conn.cursor()
        try:
            cur.execute("""
              SELECT needs_refresh,
                     COALESCE(EXTRACT(EPOCH FROM (now() - last_refresh))/60.0, 1e9) AS age_min
              FROM mview_flags
              WHERE flag='eleve_moyennes_mv'
            """)
            row = cur.fetchone()
            if not row:
                try:
                    cur.execute("""
                      INSERT INTO mview_flags(flag, needs_refresh, last_refresh)
                      VALUES ('eleve_moyennes_mv', TRUE, NULL)
                      ON CONFLICT (flag) DO NOTHING
                    """)
                    conn.commit()
                except Exception:
                    conn.rollback()
                needs_refresh, age_min = True, 1e9
            else:
                needs_refresh, age_min = row
        except Exception:
            conn.rollback()
            return
        finally:
            cur.close(); conn.close()
    except Exception:
        return

    if not (needs_refresh or age_min > max_age_minutes):
        return

    # Try concurrently, fallback simple
    try:
        conn2 = db_conn_factory(); conn2.autocommit = True
        cur2 = conn2.cursor()
        try:
            try:
                cur2.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY eleve_moyennes_mv;")
            except Exception:
                conn2.rollback()
                cur2.execute("REFRESH MATERIALIZED VIEW eleve_moyennes_mv;")
        finally:
            cur2.close(); conn2.close()
    except Exception:
        return

    # MAJ du flag si possible
    try:
        conn3 = db_conn_factory(); cur3 = conn3.cursor()
        try:
            cur3.execute("""
              UPDATE mview_flags
                 SET needs_refresh=FALSE, last_refresh=now()
               WHERE flag='eleve_moyennes_mv'
            """)
            conn3.commit()
        except Exception:
            conn3.rollback()
        finally:
            cur3.close(); conn3.close()
    except Exception:
        pass
