"""Vendor/external-docs ingestion for obsidian-tc (THE-444).

Pipeline: route a source by file type (Docling for PDFs/Office, Firecrawl for web pages,
passthrough for Markdown), parse to clean Markdown, run LangExtract for grounded chunk
records, and write md+frontmatter into a corpus vault directory that the obsidian-tc server
then indexes. See router.py / writer.py / pipeline.py.
"""
