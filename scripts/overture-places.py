"""Pizza places (category or "pizz" in the name) with a website for one country from the public Overture places parquet; edit the WHERE clause for another sector and the release name from https://stac.overturemaps.org/catalog.json ("latest"). Needs: pip install duckdb. Takes ~10-15 min per country (bbox-pruned).
python3 -I scripts/overture-places.py <AU|NZ> <out.csv>"""
import sys
import duckdb
cc, out = sys.argv[1:3]
bbox = {'AU': (112, -44, 154.5, -9), 'NZ': (166, -47.5, 179, -34)}[cc]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET threads=4;")
q = f"""
COPY (
  SELECT names.primary AS name, websites[1] AS website, taxonomy.primary AS category, operating_status AS status, addresses[1].locality AS locality
  FROM read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*', hive_partitioning=1)
  WHERE bbox.xmin >= {bbox[0]} AND bbox.ymin >= {bbox[1]} AND bbox.xmax <= {bbox[2]} AND bbox.ymax <= {bbox[3]}
    AND addresses[1].country = '{cc}'
    AND websites[1] IS NOT NULL
    AND (taxonomy.primary ILIKE '%pizza%' OR list_contains(taxonomy.hierarchy, 'pizza_restaurant') OR names.primary ILIKE '%pizz%')
) TO '{out}' (FORMAT CSV, HEADER);
"""
con.execute(q)
print(con.execute(f"select category, status, count(*) from read_csv('{out}') group by 1,2 order by 3 desc limit 15").fetchall())
